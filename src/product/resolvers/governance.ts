// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Policy governance (steward-web's A11): deletePolicy and retirePolicy at the effective-author
// tier, setPolicyOwner for site admins, movePolicy and the bulk move for site admins or those the rules give Manage (steward-gateway policy_resolver.go over
// steward-core's PolicyHandler), and the PDF export and magic links (steward-gateway
// delivery_resolver.go over steward-delivery). The refusals, messages and audit entries are
// theirs.

import { GraphQLError } from "graphql";

import type { Category } from "#product/data/library.ts";

import { type Context, type Resolvers, signedIn } from "#core/graphql.ts";
import { can } from "#product/access-rules.ts";
import { policyView, readEffect } from "#product/access.ts";
import { accepts, refusesType } from "#product/category-types.ts";
import {
  createMagicLink,
  createPdfJob,
  fingerprint,
  issuedMagicLinks,
  magicLinkStatus,
  PDF_LINK_MS,
  pdfJob,
  removeMagicLink,
  revokeMagicLink,
  signedPdfUrl,
} from "#product/delivery.ts";
import {
  editablePolicy,
  nextSequence,
  numberFor,
  policyById,
  policySubject,
  readable,
} from "#product/resolvers/policies.ts";
import {
  caller,
  data,
  forbidden,
  found,
  isSiteAdmin,
  notFound,
  now,
  record,
  refuse,
  siteAdmin,
} from "#product/resolvers/shared.ts";

/**
 * steward-gateway's authorizeMove: a site admin may move, and so may anyone the category rules
 * give Manage in each document's own category and Author in the target (Manage implies Author;
 * owners and root hold both). The site-admin gate stays beside the new one.
 */
const authorizeMove = (
  context: Context,
  policyIds: string[],
  targetId: string,
) => {
  const person = caller(context);
  if (isSiteAdmin(person)) return person;
  if (
    policyIds.length === 0 ||
    targetId === "" ||
    !can(person, targetId, "author")
  )
    throw forbidden();
  for (const id of policyIds) {
    const policy = found(policyById(id), "policy");
    if (!policy.homeCategoryId || !can(person, policy.homeCategoryId, "manage"))
      throw forbidden();
  }
  return person;
};

/** RFC 3339 to the second, as the gateway formats delivery's times. */
const rfc3339 = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A steward-delivery refusal, relayed with its registry symbol and user-safe message. */
const delivery = (code: string, message: string) =>
  new GraphQLError(message, { extensions: { code } });

/** delivery's Required(field): INVALID_REQUEST, "{field} is required." */
const required = (field: string) =>
  delivery("INVALID_REQUEST", `${field} is required.`);

/** delivery's bad-field refusal: INVALID_REQUEST naming the request field. */
const invalidField = (field: string, message: string) =>
  new GraphQLError(message, { extensions: { code: "INVALID_REQUEST", field } });

const DEFAULT_LINK_PAGE = 50;
const MAX_LINK_PAGE = 200;

/** The opaque page token is the offset into the newest-first list, as a non-negative integer. */
const linkOffset = (token: null | string | undefined) => {
  if (!token) return 0;
  if (!/^\d+$/.test(token))
    throw invalidField("page_token", "page_token is invalid.");
  return Number(token);
};

/** The gateway's read check for delivery: the version must read in full (errObfuscatedContent). */
const readableInFull = (context: Context, policyVersionId: string) => {
  const person = caller(context);
  const version = readable(person, policyVersionId);
  const policy = found(policyById(version.policyId), "policy");
  if (readEffect(person, policy) !== "allow") throw notFound("policy version");
  return { person, version };
};

/**
 * What moving each document to `target` would do: the number it would get, or why it cannot
 * move. Nothing changes. A document already there keeps its number.
 */
const planMoves = (policyIds: readonly string[], target: Category) => {
  const taken = new Map<string, number>();
  return policyIds.map((id) => {
    const policy = policyById(id);
    if (!policy) throw refuse("NOT_FOUND", "policy not found");
    const item = {
      newNumber: null as null | string,
      number: policy.number,
      policyId: policy.id,
      refusal: null as null | string,
      title: policy.title,
    };
    if (policy.retiredAt !== null)
      item.refusal = "RETIRED: a retired document cannot be moved.";
    else if (!accepts(target, policy.documentType))
      item.refusal = refusesType(target, policy.documentType).message;
    else if (policy.homeCategoryId === target.id)
      item.newNumber = policy.number;
    else {
      // The n-th document of a kind gets the n-th number, as the moves will in order.
      const { seq, stem } = nextSequence(target.id, policy.documentType);
      const earlier = taken.get(stem) ?? 0;
      taken.set(stem, earlier + 1);
      item.newNumber = `${stem}${String(seq + earlier).padStart(6, "0")}`;
    }
    return item;
  });
};

export const governanceResolvers: Resolvers = {
  Mutation: {
    createMagicLink: (
      _root,
      given: { policyVersionId: string; sensitive: boolean },
      context: Context,
    ) => {
      const { person } = readableInFull(context, given.policyVersionId);
      if (!given.policyVersionId) throw required("policy_version_id");
      const link = createMagicLink(
        given.policyVersionId,
        person.id,
        given.sensitive,
      );
      const policy = policyById(
        readable(person, given.policyVersionId).policyId,
      );
      record("magic_link.created", person, {
        groupId: policy?.homeCategoryId,
        id: given.policyVersionId,
        kind: "policy_version",
        label: policy?.title ?? null,
      });
      return { expiresAt: rfc3339(link.expiresAt), token: link.token };
    },
    /** core's DeletePolicy: never-published policies only; their versions go with them. */
    deletePolicy: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      const policy = editablePolicy(person, given.id);
      const everPublished =
        policy.currentPublishedVersionId !== null ||
        data().versions.some(
          (v) =>
            v.policyId === policy.id &&
            (v.status === "PUBLISHED" || v.status === "SUPERSEDED"),
        );
      if (everPublished)
        throw refuse(
          "FAILED_PRECONDITION",
          `delete policy: PolicyStore.DeletePolicy ${policy.id}: policy has a published version and cannot be deleted`,
        );
      const subject = policySubject(policy);
      for (const v of data().versions)
        if (v.policyId === policy.id) delete data().links[v.id];
      data().policies = data().policies.filter((p) => p.id !== policy.id);
      data().versions = data().versions.filter((v) => v.policyId !== policy.id);
      record("policy.deleted", person, subject);
      return true;
    },
    /** core's bulk move (steward-core#35): all or nothing, each renumbered in the target's sequence. */
    movePolicies: (
      _root,
      given: { homeCategoryId: string; policyIds: string[] },
      context: Context,
    ) => {
      const admin = authorizeMove(
        context,
        given.policyIds,
        given.homeCategoryId,
      );
      if (given.policyIds.length === 0)
        throw refuse("BAD_USER_INPUT", "Pick at least one document to move.");
      const target = data().categories.find(
        (c) => c.id === given.homeCategoryId,
      );
      if (!target) throw refuse("NOT_FOUND", "target category not found");
      const plan = planMoves(given.policyIds, target);
      const refused = plan.find((item) => item.refusal);
      if (refused) throw refuse("FAILED_PRECONDITION", refused.refusal!);
      const moved = given.policyIds.map((id) => {
        const policy = policyById(id)!;
        const before = policy.number;
        if (policy.homeCategoryId !== target.id) {
          policy.number = numberFor(target.id, policy.documentType);
          policy.homeCategoryId = target.id;
          policy.updatedAt = now();
          record("policy.moved", admin, policySubject(policy));
        }
        return {
          newNumber: policy.number,
          number: before,
          policyId: policy.id,
          refusal: null,
          title: policy.title,
        };
      });
      record("policy.bulk_moved", admin, {
        groupId: target.id,
        groupName: target.name,
        id: target.id,
        kind: "category",
        label: `${String(moved.length)} documents to ${target.name}`,
      });
      return { moved };
    },
    /** core's MovePolicy: a new home and the next number in its sequence; the same home is a no-op. */
    movePolicy: (
      _root,
      given: { homeCategoryId: string; policyId: string },
      context: Context,
    ) => {
      const admin = authorizeMove(
        context,
        [given.policyId],
        given.homeCategoryId,
      );
      const policy = policyById(given.policyId);
      if (!policy) throw refuse("NOT_FOUND", "policy not found");
      if (policy.homeCategoryId === given.homeCategoryId)
        return policyView(admin, policy);
      const target = data().categories.find(
        (c) => c.id === given.homeCategoryId,
      );
      if (!target) throw refuse("NOT_FOUND", "target category not found");
      if (!accepts(target, policy.documentType))
        throw refusesType(target, policy.documentType);
      policy.number = numberFor(given.homeCategoryId, policy.documentType);
      policy.homeCategoryId = given.homeCategoryId;
      policy.updatedAt = now();
      record("policy.moved", admin, policySubject(policy));
      return policyView(admin, policy);
    },
    /** delivery's RemoveMagicLink: a revoked or expired link only; site admins. */
    removeMagicLink: (_root, given: { token: string }, context: Context) => {
      siteAdmin(context);
      if (!given.token) throw required("token");
      const outcome = removeMagicLink(given.token);
      if (outcome === "missing")
        throw delivery(
          "MAGIC_LINK_NOT_FOUND",
          "That magic link doesn't exist.",
        );
      if (outcome === "active")
        throw delivery(
          "MAGIC_LINK_ACTIVE",
          "Revoke that magic link before removing it.",
        );
      return true;
    },
    requestPDFExport: (
      _root,
      given: { policyVersionId: string },
      context: Context,
    ) => {
      const { person } = readableInFull(context, given.policyVersionId);
      return { jobId: createPdfJob(given.policyVersionId, person.id) };
    },
    /** core's RetirePolicy: sets retiredAt once; listings and obligations then leave it out. */
    retirePolicy: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      const policy = editablePolicy(person, given.id);
      if (policy.retiredAt === null) {
        policy.retiredAt = now();
        policy.updatedAt = policy.retiredAt;
      }
      record("policy.retired", person, policySubject(policy));
      return policyView(person, policy);
    },
    /** delivery's RevokeMagicLink: delivery.manage, which only site admins hold. */
    revokeMagicLink: (_root, given: { token: string }, context: Context) => {
      const admin = siteAdmin(context);
      if (!given.token) throw required("token");
      revokeMagicLink(given.token, admin.id);
      record("magic_link.revoked", admin, {
        id: fingerprint(given.token),
        kind: "magic_link",
        label: null,
      });
      return true;
    },
    setPolicyOwner: (
      _root,
      given: { ownerUserId: string; policyId: string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const policy = policyById(given.policyId);
      if (!policy) throw refuse("NOT_FOUND", "policy not found");
      policy.ownerUserId = given.ownerUserId;
      policy.updatedAt = now();
      record("policy.owner_changed", admin, policySubject(policy));
      return policyView(admin, policy);
    },
  },
  Query: {
    /** delivery's ListMagicLinks: site admins; newest first; optional policy version filter. */
    magicLinks: (
      _root,
      given: {
        pageSize?: null | number;
        pageToken?: null | string;
        policyVersionIds?: null | string[];
      },
      context: Context,
    ) => {
      siteAdmin(context);
      const size = given.pageSize ?? DEFAULT_LINK_PAGE;
      if (size < 1 || size > MAX_LINK_PAGE)
        throw invalidField("page_size", "page_size must be 1 to 200.");
      const offset = linkOffset(given.pageToken);
      const wanted = given.policyVersionIds?.length
        ? new Set(given.policyVersionIds)
        : undefined;
      const matching = issuedMagicLinks().filter(
        ({ link }) => !wanted || wanted.has(link.policyVersionId),
      );
      const end = offset + size;
      return {
        links: matching.slice(offset, end).map(({ link, token }) => ({
          createdAt: rfc3339(link.createdAt),
          createdByUserId: link.createdBy,
          expiresAt: rfc3339(link.expiresAt),
          fingerprint: fingerprint(token),
          policyVersionId: link.policyVersionId,
          revokedAt: link.revokedAt === null ? null : rfc3339(link.revokedAt),
          revokedByUserId: link.revokedBy,
          sensitive: link.sensitive,
          status: magicLinkStatus(link),
          token,
        })),
        nextPageToken: end < matching.length ? String(end) : null,
      };
    },
    /** delivery's GetPDFDownloadLink: the job's sample PDF, signed for PDF_LINK_MS. */
    pdfDownloadLink: (_root, given: { jobId: string }, context: Context) => {
      signedIn(context);
      if (!given.jobId) throw required("job_id");
      if (!pdfJob(given.jobId))
        throw delivery(
          "PDF_EXPORT_NOT_FOUND",
          "That PDF export doesn't exist.",
        );
      const expiresAt = Date.now() + PDF_LINK_MS;
      return {
        expiresAt: rfc3339(expiresAt),
        signedUrl: signedPdfUrl(given.jobId, expiresAt),
      };
    },
    previewMovePolicies: (
      _root,
      given: { homeCategoryId: string; policyIds: string[] },
      context: Context,
    ) => {
      authorizeMove(context, given.policyIds, given.homeCategoryId);
      const target = data().categories.find(
        (c) => c.id === given.homeCategoryId,
      );
      if (!target) throw refuse("NOT_FOUND", "target category not found");
      return { items: planMoves(given.policyIds, target) };
    },
  },
};
