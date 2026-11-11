// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Policies and their versions: the library and the reader read the same records that create,
// save, publish and discard write, through the viewer's read model (access.ts). Numbers follow
// steward-core: POL or PRC, the home category's code, then a six-digit sequence per category and
// kind.

import type { StewardPerson } from "#product/data/people.ts";
import type { Policy, PolicyVersion } from "#product/data/policies.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import {
  canAuthorIn,
  canEdit,
  chainOf,
  policyView,
  readableVersion,
  readEffect,
  scrambled,
  visible,
} from "#product/access.ts";
import { syncAppendices } from "#product/appendices.ts";
import { accepts, refusesType } from "#product/category-types.ts";
import { collabPath, collabToken } from "#product/collab.ts";
import {
  byTitle,
  carryOver,
  currentVersionId,
  emptyLinks,
  usedByPolicies,
  type VersionLinks,
} from "#product/links.ts";
import {
  caller,
  data,
  forbidden,
  found,
  isSiteAdmin,
  newId,
  notFound,
  now,
  record,
  refuse,
} from "#product/resolvers/shared.ts";
import { diffVersions } from "#product/sections.ts";

/** How long a break-glass grant lasts. */
const BREAK_GLASS_MS = 5 * 60 * 1000;

/** How long a collab token is valid. */
const COLLAB_TOKEN_MS = 5 * 60 * 1000;

export const policyById = (id: string) =>
  data().policies.find((p) => p.id === id);

const versionById = (id: null | string) =>
  id ? data().versions.find((v) => v.id === id) : undefined;

/** A policy the person may see, or NOT_FOUND as the gateway answers for a hidden one. */
export const visiblePolicy = (person: StewardPerson, id: string): Policy => {
  const policy = policyById(id);
  if (!policy || !visible(person, policy)) throw notFound("policy");
  return policy;
};

/** A policy the person may author, or FORBIDDEN (authorizeEffectiveAuthor). */
export const editablePolicy = (person: StewardPerson, id: string): Policy => {
  const policy = found(policyById(id), "policy");
  if (!canEdit(person, policy)) throw forbidden();
  return policy;
};

export const policySubject = (policy: Policy) => {
  const home = data().categories.find((c) => c.id === policy.homeCategoryId);
  return {
    groupId: policy.homeCategoryId,
    groupName: home?.name ?? null,
    id: policy.id,
    kind: "policy",
    label: policy.title,
  };
};

/** A policy version as an audit subject: steward-core files draft saves, publishes and status
 *  changes under it, and steward-workflow files every run event under it. */
export const versionSubject = (policy: Policy, versionId: string) => ({
  ...policySubject(policy),
  id: versionId,
  kind: "policy_version",
});

/**
 * steward-core's derived code, for a category with no stored one: the slug in capitals, letters
 * and digits only, six at most.
 */
const codeOf = (slug: string): string =>
  slug
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, "")
    .slice(0, 6) || "GEN";

/**
 * The next number in a category for a kind of document: steward-core's category_policy_seq, a
 * counter per category and kind that only goes up, so a number a policy moved away with is never
 * reused.
 */
export const numberFor = (
  categoryId: string,
  documentType: Policy["documentType"],
): string => {
  const { counter, seq, stem } = nextSequence(categoryId, documentType);
  data().next[counter] = seq;
  return `${stem}${String(seq).padStart(6, "0")}`;
};

/** The number a category would give next, without taking it. */
export const nextSequence = (
  categoryId: string,
  documentType: Policy["documentType"],
) => {
  const prefix = documentType === "PROCEDURE" ? "PRC" : "POL";
  const category = data().categories.find((c) => c.id === categoryId);
  const code = category?.code ?? codeOf(category?.slug ?? "");
  const stem = `${prefix}-${code}-`;
  const taken = data()
    .policies.filter((p) => p.number.startsWith(stem))
    .map((p) => Number(p.number.slice(stem.length)));
  const counter = `seq:${categoryId}:${documentType}`;
  return {
    counter,
    seq: Math.max(data().next[counter] ?? 0, ...taken, 0) + 1,
    stem,
  };
};

const textNode = (value: string) => ({
  detail: 0,
  format: 0,
  mode: "normal",
  style: "",
  text: value,
  type: "text",
  version: 1,
});

/** A new draft's content: a heading and an empty paragraph per template section. */
const scaffold = (titles: string[]): string =>
  JSON.stringify({
    root: {
      children: titles.flatMap((title) => [
        {
          children: [textNode(title)],
          direction: null,
          format: "",
          indent: 0,
          tag: "h1",
          type: "heading",
          version: 1,
        },
        {
          children: [],
          direction: null,
          format: "",
          indent: 0,
          textFormat: 0,
          textStyle: "",
          type: "paragraph",
          version: 1,
        },
      ]),
      direction: null,
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  });

/**
 * What a draft holds while the author has not written in it: the scaffold of the template version
 * it is pinned to. Undefined when that template version is not known.
 */
const startingContent = (draft: PolicyVersion): string | undefined => {
  if (draft.templateVersionId === "") return scaffold([]);
  const pinned = data().templateVersions.find(
    (t) => t.id === draft.templateVersionId,
  );
  return pinned
    ? scaffold(
        pinned.sections
          .toSorted((a, b) => a.order - b.order)
          .map((s) => s.title),
      )
    : undefined;
};

/** The template a new policy starts from: the one asked for, else the category chain's. */
const templateFor = (categoryId: string, templateId?: null | string) => {
  if (templateId) return templateId;
  for (const category of chainOf(categoryId)) {
    if (category.defaultTemplateNone) return null;
    if (category.defaultTemplateId) return category.defaultTemplateId;
  }
  return null;
};

/**
 * The template the category chain locks authors to, if any: the nearest category that names a
 * default (or none) provides it, and it binds only when that category is locked.
 */
const lockedTemplate = (categoryId: string): null | string => {
  for (const category of chainOf(categoryId)) {
    if (category.defaultTemplateNone) return null;
    if (category.defaultTemplateId)
      return category.defaultTemplateLocked ? category.defaultTemplateId : null;
  }
  return null;
};

/** Refuses a template other than the one the category locks authors to (FAILED_PRECONDITION). */
const requireLockedTemplate = (
  categoryId: string,
  templateId: null | string | undefined,
): void => {
  const locked = lockedTemplate(categoryId);
  if (locked && templateId !== locked) {
    const name = data().templates.find((t) => t.id === locked)?.name ?? locked;
    throw refuse(
      "FAILED_PRECONDITION",
      `This category requires the ${name} template.`,
    );
  }
};

const latestPublished = (templateId: null | string) =>
  templateId
    ? data()
        .templateVersions.filter(
          (v) => v.templateId === templateId && v.status === "published",
        )
        .toSorted((a, b) => b.versionNo - a.versionNo)[0]
    : undefined;

/** End an approval run that is still open on a version, as a new publish or discard does. */
export const cancelRuns = (versionId: string): void => {
  for (const run of data().runs) {
    if (
      run.policyVersionId !== versionId ||
      run.status !== "APPROVAL_STATUS_IN_REVIEW"
    )
      continue;
    run.status = "APPROVAL_STATUS_WITHDRAWN";
    for (const stage of run.stages)
      for (const seat of stage.seats)
        if (seat.state === "pending") seat.state = "cancelled";
  }
};

/** Publish a version: it gets the next number, and the one before it is superseded. */
export const publishVersion = (
  policy: Policy,
  version: PolicyVersion,
): void => {
  const at = now();
  const previous = versionById(policy.currentPublishedVersionId);
  if (previous) previous.status = "SUPERSEDED";
  version.versionNo =
    Math.max(
      0,
      ...data()
        .versions.filter((v) => v.policyId === policy.id)
        .map((v) => v.versionNo),
    ) + 1;
  version.status = "PUBLISHED";
  version.publishedAt = at;
  policy.currentPublishedVersionId = version.id;
  if (policy.currentDraftVersionId === version.id)
    policy.currentDraftVersionId = null;
  policy.updatedAt = at;
};

/**
 * core's DiffVersions over the "to" version's pinned template sections, keyed as core keys them
 * (src/product/sections.ts). A version with no pinned template has no sections to diff, which
 * core refuses as an internal fault. The gateway drops the word diff and scrambles the titles for
 * an obfuscated read.
 */
const diff = (from: PolicyVersion, to: PolicyVersion, obscured: boolean) => {
  const template = data().templateVersions.find(
    (t) => t.id === to.templateVersionId,
  );
  if (!template) throw refuse("INTERNAL", "fetch template version: not found");
  const diffs = diffVersions(
    from.contentJson,
    to.contentJson,
    template.sections.toSorted((a, b) => a.order - b.order),
    from.templateVersionId !== to.templateVersionId,
  );
  if (!diffs) throw refuse("INTERNAL", "diff: parse content");
  return diffs.map((d) => ({
    ...d,
    sectionTitle: obscured ? scrambled(d.sectionTitle) : d.sectionTitle,
    wordDiffHtml: obscured || d.wordDiffHtml === "" ? null : d.wordDiffHtml,
  }));
};

export const readable = (person: StewardPerson, id: string): PolicyVersion => {
  const version = versionById(id);
  const shown = version ? readableVersion(person, version) : undefined;
  if (!shown) throw notFound("policy version");
  return shown;
};

/** The links a policy shows when no version is named: its published version's, else its draft's. */
const linksOf = (policyId: string): VersionLinks => {
  const policy = policyById(policyId);
  const versionId = policy ? currentVersionId(policy) : null;
  return (versionId ? data().links[versionId] : undefined) ?? emptyLinks();
};

const usage = (pick: (links: VersionLinks) => string[], id: string) =>
  usedByPolicies(data().links, data().policies, pick, id);

export const policyResolvers: Resolvers = {
  Mutation: {
    breakGlassReveal: (
      _root,
      given: { policyId: string; reason: string },
      context: Context,
    ) => {
      const person = caller(context);
      if (!isSiteAdmin(person)) throw forbidden();
      if (!given.reason.trim())
        throw refuse("BAD_USER_INPUT", "A reason is required.");
      const policy = found(policyById(given.policyId), "policy");
      const until = Date.now() + BREAK_GLASS_MS;
      data().breakGlass.push({
        policyNumber: policy.number,
        until,
        userId: person.id,
      });
      // steward-identity files the grant under the person it was granted to.
      record("policy.break_glass_revealed", person, {
        id: person.id,
        kind: "user",
        label: person.name,
      });
      return { grantedUntil: new Date(until).toISOString() };
    },
    createPolicy: (
      _root,
      given: {
        documentType?: null | Policy["documentType"];
        homeCategoryId: string;
        sensitivity: Policy["sensitivity"];
        templateId?: null | string;
        title: string;
      },
      context: Context,
    ) => {
      const person = caller(context);
      const home = found(
        data().categories.find((c) => c.id === given.homeCategoryId),
        "category",
      );
      if (!canAuthorIn(person, given.homeCategoryId)) throw forbidden();
      if (!given.title.trim())
        throw refuse("BAD_USER_INPUT", "A policy needs a title.");
      const documentType = given.documentType ?? "POLICY";
      if (!accepts(home, documentType)) throw refusesType(home, documentType);
      if (given.templateId) requireLockedTemplate(home.id, given.templateId);
      const templateId = templateFor(given.homeCategoryId, given.templateId);
      const templateVersion = latestPublished(templateId);
      if (given.templateId && !templateVersion) throw notFound("template");
      const at = now();
      const policy: Policy = {
        ackAudienceOverride: null,
        ackTriggers: null,
        createdAt: at,
        currentDraftVersionId: newId("version"),
        currentPublishedVersionId: null,
        documentType,
        homeCategoryId: given.homeCategoryId,
        id: newId("policy"),
        number: numberFor(given.homeCategoryId, documentType),
        ownerUserId: person.id,
        retiredAt: null,
        sensitivity: given.sensitivity,
        templateId: given.templateId ?? null,
        templateNone: !templateId,
        title: given.title.trim(),
        updatedAt: at,
        workflowDefId: null,
      };
      data().versions.push({
        appendices: [],
        contentJson: scaffold(
          (templateVersion?.sections ?? [])
            .toSorted((a, b) => a.order - b.order)
            .map((s) => s.title),
        ),
        createdAt: at,
        id: policy.currentDraftVersionId ?? "",
        policyId: policy.id,
        publishedAt: null,
        status: "DRAFT",
        templateVersionId: templateVersion?.id ?? "",
        versionNo: 0,
      });
      data().policies.push(policy);
      record("policy.created", person, policySubject(policy));
      record(
        "policy.draft_saved",
        person,
        versionSubject(policy, policy.currentDraftVersionId ?? ""),
      );
      return policyView(person, policy);
    },
    discardDraft: (_root, given: { policyId: string }, context: Context) => {
      const person = caller(context);
      const policy = editablePolicy(person, given.policyId);
      const draftId = policy.currentDraftVersionId;
      if (!draftId) return true;
      cancelRuns(draftId);
      data().versions = data().versions.filter((v) => v.id !== draftId);
      policy.currentDraftVersionId = null;
      policy.updatedAt = now();
      record("policy.draft_discarded", person, policySubject(policy));
      return true;
    },
    issueCollabToken: (
      _root,
      given: { input: { draftId: string; policyId: string } },
      context: Context,
    ) => {
      const person = caller(context);
      const policy = editablePolicy(person, given.input.policyId);
      if (policy.currentDraftVersionId !== given.input.draftId)
        throw notFound("draft");
      const expiresAt = new Date(Date.now() + COLLAB_TOKEN_MS);
      return {
        expiresAt: expiresAt.toISOString(),
        token: collabToken({
          draftId: given.input.draftId,
          expiresAt,
          policyId: policy.id,
          userId: person.id,
        }),
        wsUrl: collabPath(given.input.draftId),
      };
    },
    publishDraft: (_root, given: { policyId: string }, context: Context) => {
      const person = caller(context);
      const policy = editablePolicy(person, given.policyId);
      const draft = found(versionById(policy.currentDraftVersionId), "draft");
      cancelRuns(draft.id);
      publishVersion(policy, draft);
      record("policy.published", person, versionSubject(policy, draft.id));
      return draft;
    },
    saveDraft: (
      _root,
      given: {
        contentJson: string;
        policyId: string;
        templateVersionId?: null | string;
      },
      context: Context,
    ) => {
      const person = caller(context);
      const policy = editablePolicy(person, given.policyId);
      const at = now();
      let draft = versionById(policy.currentDraftVersionId);
      // A rejection is final: the rejected version stays as it was and the next save starts a new
      // draft, which needs a full new submission. Its template carries over unless one is given.
      const rejected = draft?.status === "REJECTED" ? draft : undefined;
      if (rejected) draft = undefined;
      if (!draft) {
        const draftId = newId("version");
        draft = {
          appendices: [],
          contentJson: given.contentJson,
          createdAt: at,
          id: draftId,
          policyId: policy.id,
          publishedAt: null,
          status: "DRAFT",
          templateVersionId:
            given.templateVersionId ?? rejected?.templateVersionId ?? "",
          versionNo: 0,
        };
        data().versions.push(draft);
        // the links come along: from the rejected version after a rejection, else the published one
        carryOver(
          data().links,
          rejected ?? versionById(policy.currentPublishedVersionId),
          draft,
        );
        syncAppendices(data().appendices, data().versions, policy.id);
        policy.currentDraftVersionId = draft.id;
      }
      draft.contentJson = given.contentJson;
      if (given.templateVersionId !== undefined)
        draft.templateVersionId = given.templateVersionId ?? "";
      // Editing a withdrawn draft makes it a plain draft again; one in review stays in review.
      if (draft.status === "WITHDRAWN") draft.status = "DRAFT";
      policy.updatedAt = at;
      record("policy.draft_saved", person, versionSubject(policy, draft.id));
      return draft;
    },
    setPolicyTemplate: (
      _root,
      given: { none: boolean; policyId: string; templateId?: null | string },
      context: Context,
    ) => {
      const person = caller(context);
      const policy = editablePolicy(person, given.policyId);
      requireLockedTemplate(
        policy.homeCategoryId,
        given.none ? null : given.templateId,
      );
      const template = given.none
        ? undefined
        : latestPublished(given.templateId ?? null);
      if (!given.none && given.templateId && !template)
        throw notFound("template");
      // the draft the policy started with, if the author has not written in it yet, starts again
      // from the new choice: freeform is blank, a template brings its sections
      const draft = versionById(policy.currentDraftVersionId);
      const started = draft ? startingContent(draft) : undefined;
      policy.templateId = given.none ? null : (given.templateId ?? null);
      policy.templateNone = given.none;
      const effective = given.none
        ? undefined
        : (template ??
          latestPublished(templateFor(policy.homeCategoryId, null)));
      if (draft && started !== undefined && draft.contentJson === started) {
        draft.contentJson = scaffold(
          (effective?.sections ?? [])
            .toSorted((a, b) => a.order - b.order)
            .map((s) => s.title),
        );
        draft.templateVersionId = effective?.id ?? "";
      }
      policy.updatedAt = now();
      record("policy.template_changed", person, policySubject(policy));
      return policyView(person, policy);
    },
  },
  Query: {
    diffVersions: (
      _root,
      given: { fromVersionId: string; toVersionId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const from = readable(person, given.fromVersionId);
      const to = readable(person, given.toVersionId);
      const policy = found(policyById(to.policyId), "policy");
      // The gateway diffs the real text, then drops the word diff for an obfuscated read.
      return diff(
        versionById(from.id) as PolicyVersion,
        versionById(to.id) as PolicyVersion,
        readEffect(person, policy) !== "allow",
      );
    },
    myDrafts: (_root, _given, context: Context) => {
      const person = caller(context);
      return data()
        .policies.filter(
          (p) => p.ownerUserId === person.id && p.currentDraftVersionId,
        )
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((p) => policyView(person, p));
    },
    policies: (
      _root,
      given: {
        categoryId: string;
        documentType?: null | Policy["documentType"];
        includeDescendants?: boolean | null;
      },
      context: Context,
    ) => {
      const person = caller(context);
      const kind = given.documentType ?? "POLICY";
      const inScope = (categoryId: string) =>
        given.includeDescendants
          ? chainOf(categoryId).some((c) => c.id === given.categoryId)
          : categoryId === given.categoryId;
      return data()
        .policies.filter(
          (p) =>
            p.documentType === kind &&
            p.retiredAt === null &&
            inScope(p.homeCategoryId) &&
            visible(person, p),
        )
        .map((p) => policyView(person, p));
    },
    policy: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      return policyView(person, visiblePolicy(person, given.id));
    },
    policyByNumber: (_root, given: { number: string }, context: Context) => {
      const person = caller(context);
      const policy = data().policies.find((p) => p.number === given.number);
      if (!policy || !visible(person, policy)) throw notFound("policy");
      return policyView(person, policy);
    },
    policyContactBlocks: (
      _root,
      given: { policyId: string },
      context: Context,
    ) => {
      caller(context);
      // in the order the author gave, not the library's
      return linksOf(given.policyId).contactBlockIds.flatMap((id) => {
        const block = data().contactBlocks.find((b) => b.id === id);
        return block
          ? [{ ...block, usedByCount: usage((l) => l.contactBlockIds, id) }]
          : [];
      });
    },
    policyDefinitionEntries: (
      _root,
      given: { policyId: string },
      context: Context,
    ) => {
      caller(context);
      // alphabetical by title
      return linksOf(given.policyId)
        .definitionIds.flatMap((id) => {
          const entry = data().definitions.find((d) => d.id === id);
          return entry
            ? [{ ...entry, usedByCount: usage((l) => l.definitionIds, id) }]
            : [];
        })
        .toSorted((a, b) => byTitle(a.term, b.term));
    },
    policyReferences: (
      _root,
      given: { policyId: string },
      context: Context,
    ) => {
      caller(context);
      return linksOf(given.policyId).referenceIds.flatMap((id) => {
        const entry = data().references.find((r) => r.id === id);
        return entry
          ? [{ ...entry, usedByCount: usage((l) => l.referenceIds, id) }]
          : [];
      });
    },
    policyVersion: (_root, given: { id: string }, context: Context) =>
      readable(caller(context), given.id),
    policyVersions: (_root, given: { policyId: string }, context: Context) => {
      const person = caller(context);
      const policy = found(policyById(given.policyId), "policy");
      if (readEffect(person, policy) === "deny") throw notFound("policy");
      return data()
        .versions.filter((v) => v.policyId === policy.id && v.publishedAt)
        .toSorted((a, b) => a.versionNo - b.versionNo)
        .flatMap((v) => readableVersion(person, v) ?? []);
    },
    relatedPolicies: (_root, given: { policyId: string }, context: Context) => {
      const person = caller(context);
      return linksOf(given.policyId).related.flatMap(({ policyId: id }) => {
        const related = policyById(id);
        return related && visible(person, related)
          ? [
              {
                number: related.number,
                policyId: related.id,
                title: related.title,
              },
            ]
          : [];
      });
    },
  },
};
