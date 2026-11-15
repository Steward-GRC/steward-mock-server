// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The appendix life cycle (see appendices.ts and the pending schema): create, save a draft,
// publish, retire and restore, delete for good, reorder, and the diff of a draft against what is
// published. Whoever may author the policy or procedure has the same rights on its appendices; a
// site admin alone deletes one for good; compliance may read the diff. Readers see only published
// rows. PolicyVersion.appendices answers the latest published appendix of each live appendix, on
// every version of the policy.

import type { StewardPerson } from "#product/data/people.ts";
import type { Policy, PolicyVersion } from "#product/data/policies.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { canEdit, obfuscated, readEffect, visible } from "#product/access.ts";
import {
  appendicesOf,
  type AppendixVersionRow,
  contributorIds,
  defaultTitle,
  draftOf,
  latestPublished,
  letterFor,
  liveAppendices,
  noteEditor,
  type PolicyAppendix,
  publishedRows,
  renumber,
  syncAppendices,
} from "#product/appendices.ts";
import { APPENDIX_ROOM, collabPath, collabToken } from "#product/collab.ts";
import {
  caller,
  data,
  forbidden,
  found,
  isSiteAdmin,
  newId,
  notFound,
  now,
  personOf,
  refuse,
} from "#product/resolvers/shared.ts";
import { diffVersions, parseContent } from "#product/sections.ts";

const policyOf = (id: string): Policy =>
  found(
    data().policies.find((p) => p.id === id),
    "policy",
  );

/** A policy the person may read at all, or NOT_FOUND as the gateway answers for a hidden one. */
const readablePolicy = (person: StewardPerson, id: string): Policy => {
  const policy = data().policies.find((p) => p.id === id);
  if (!policy || !visible(person, policy)) throw notFound("policy");
  return policy;
};

/** A policy the person may edit (the same right that creates and edits the policy), or FORBIDDEN. */
const editablePolicy = (person: StewardPerson, id: string): Policy => {
  const policy = readablePolicy(person, id);
  if (!canEdit(person, policy) && !isSiteAdmin(person)) throw forbidden();
  return policy;
};

const appendixById = (id: string): PolicyAppendix =>
  found(
    data().appendices.find((a) => a.id === id),
    "appendix",
  );

/** An appendix of a policy the person may edit. */
const editable = (person: StewardPerson, id: string) => {
  const appendix = appendixById(id);
  editablePolicy(person, appendix.policyId);
  return appendix;
};

const mayRead = (person: StewardPerson, policy: Policy): boolean =>
  canEdit(person, policy) || isSiteAdmin(person);

/** Who sees the diff and the contributors: authors, site admins and compliance. */
const mayDiff = (person: StewardPerson, policy: Policy): boolean =>
  mayRead(person, policy) || person.roles.includes("compliance-admin");

/** People by id, as contributors: a disabled or removed person still shows, with a name. */
const contributorsOf = (ids: readonly string[]) =>
  ids.map((id) => {
    const found = personOf(id);
    return {
      active: found ? !found.disabled && !found.deletedAt : false,
      name: found?.name ?? id,
      userId: id,
    };
  });

/** An appendix as the person may read it: readers get no draft and no history. */
const view = (person: StewardPerson, appendix: PolicyAppendix) => {
  const policy = policyOf(appendix.policyId);
  const editor = mayRead(person, policy);
  const who = mayDiff(person, policy);
  const published = latestPublished(appendix) ?? null;
  const show = (row: AppendixVersionRow | null | undefined) => {
    if (!row) return null;
    const shown = {
      ...row,
      contributors: who ? contributorsOf(row.editors) : [],
    };
    return readEffect(person, policy) === "obfuscate"
      ? { ...shown, contentJson: obfuscated(row.contentJson) }
      : shown;
  };
  const readerRows = published ? [show(published)] : [];
  const versionsShown = editor
    ? appendix.versions.map((v) => show(v))
    : readerRows;
  return {
    ...appendix,
    contributors: who ? contributorsOf(contributorIds(appendix)) : [],
    draft: editor ? show(draftOf(appendix)) : null,
    letter: letterFor(data().appendices, appendix),
    published: show(published),
    publishedVersions: editor
      ? publishedRows(appendix)
          .toReversed()
          .map((v) => show(v))
      : readerRows,
    versions: versionsShown,
  };
};

const touch = (policy: Policy) => {
  policy.updatedAt = now();
  syncAppendices(data().appendices, data().versions, policy.id);
};

/** The text of an appendix's content for the diff: the old {text} shape counts as one section. */
const sectionsOf = (contentJson: string): Map<string, string> => {
  try {
    const parsed = JSON.parse(contentJson) as { text?: unknown };
    if (typeof parsed.text === "string")
      return new Map(parsed.text ? [["body", parsed.text]] : []);
  } catch {
    // Not JSON: no sections.
  }
  return parseContent(contentJson) ?? new Map();
};

const envelope = (sections: Map<string, string>): string =>
  JSON.stringify({ sections: Object.fromEntries(sections) });

/**
 * The gateway's version-bound appendix mutations, still answered until the clients move to the
 * life cycle: they act on the policy's appendices, and what is saved is published at once.
 */
const legacyShape = (appendix: PolicyAppendix, versionId: string) => {
  const row = latestPublished(appendix);
  const index = liveAppendices(data().appendices, appendix.policyId).indexOf(
    appendix,
  );
  return {
    contentJson: row?.contentJson ?? "",
    id: appendix.id,
    letter: String.fromCodePoint(65 + Math.max(index, 0)),
    orderIndex: Math.max(index, 0),
    policyVersionId: versionId,
    title: row?.title ?? "",
  };
};

const versionPolicy = (versionId: string): PolicyVersion =>
  found(
    data().versions.find((v) => v.id === versionId),
    "policy version",
  );

const createPublished = (
  person: StewardPerson,
  policy: Policy,
  title: string,
  contentJson: string,
): PolicyAppendix => {
  const all = data().appendices;
  const at = now();
  const appendix: PolicyAppendix = {
    createdAt: at,
    createdBy: person.id,
    id: newId("appendix"),
    orderIndex: liveAppendices(all, policy.id).length,
    policyId: policy.id,
    retiredAt: null,
    retiredBy: null,
    versions: [
      {
        contentJson,
        createdAt: at,
        createdBy: person.id,
        editors: [person.id],
        id: "",
        publishedAt: at,
        publishedBy: person.id,
        state: "PUBLISHED",
        title,
        updatedAt: at,
        updatedBy: person.id,
        versionNo: 1,
      },
    ],
  };
  appendix.versions[0]!.id = `${appendix.id}-v1`;
  all.push(appendix);
  touch(policy);
  return appendix;
};

export const appendixResolvers: Resolvers = {
  Mutation: {
    addAppendix: (
      _root,
      given: { contentJson: string; policyVersionId: string; title: string },
      context: Context,
    ) => {
      const person = caller(context);
      const version = versionPolicy(given.policyVersionId);
      const policy = editablePolicy(person, version.policyId);
      return legacyShape(
        createPublished(
          person,
          policy,
          given.title.trim() || defaultTitle(data().appendices, policy.id),
          given.contentJson,
        ),
        version.id,
      );
    },
    createPolicyAppendix: (
      _root,
      given: { contentJson: string; policyId: string; title?: null | string },
      context: Context,
    ) => {
      const person = caller(context);
      const policy = editablePolicy(person, given.policyId);
      const all = data().appendices;
      const title = given.title?.trim() || defaultTitle(all, policy.id);
      const at = now();
      const appendix: PolicyAppendix = {
        createdAt: at,
        createdBy: person.id,
        id: newId("appendix"),
        orderIndex: liveAppendices(all, policy.id).length,
        policyId: policy.id,
        retiredAt: null,
        retiredBy: null,
        versions: [],
      };
      appendix.versions.push({
        contentJson: given.contentJson,
        createdAt: at,
        createdBy: person.id,
        editors: [person.id],
        id: `${appendix.id}-v1`,
        publishedAt: null,
        publishedBy: null,
        state: "DRAFT",
        title,
        updatedAt: at,
        updatedBy: person.id,
        versionNo: 1,
      });
      all.push(appendix);
      touch(policy);
      return view(person, appendix);
    },
    deleteAppendix: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      const appendix = editable(person, given.id);
      appendix.retiredAt = now();
      appendix.retiredBy = person.id;
      renumber(data().appendices, appendix.policyId);
      touch(policyOf(appendix.policyId));
      return true;
    },
    deleteAppendixForever: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      const appendix = appendixById(given.id);
      if (!isSiteAdmin(person)) throw forbidden();
      // Core refuses a live appendix (FAILED_PRECONDITION): retire it first.
      if (appendix.retiredAt === null)
        throw refuse(
          "FAILED_PRECONDITION",
          "Retire the appendix before deleting it for good.",
        );
      const all = data().appendices;
      all.splice(all.indexOf(appendix), 1);
      renumber(all, appendix.policyId);
      syncAppendices(all, data().versions, appendix.policyId);
      return true;
    },
    issueAppendixCollabToken: (
      _root,
      given: { appendixId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const appendix = editable(person, given.appendixId);
      if (appendix.retiredAt !== null)
        throw refuse(
          "FAILED_PRECONDITION",
          "A retired appendix can't be edited; restore it first.",
        );
      const room = `${APPENDIX_ROOM}${appendix.id}`;
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      return {
        expiresAt: expiresAt.toISOString(),
        token: collabToken({
          draftId: room,
          expiresAt,
          policyId: appendix.policyId,
          userId: person.id,
        }),
        wsUrl: collabPath(room),
      };
    },
    publishAppendix: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      const appendix = editable(person, given.id);
      const draft = draftOf(appendix);
      if (!draft)
        throw refuse(
          "FAILED_PRECONDITION",
          "There is no draft of this appendix to publish.",
        );
      const at = now();
      draft.state = "PUBLISHED";
      draft.publishedAt = at;
      draft.publishedBy = person.id;
      draft.updatedAt = at;
      draft.updatedBy = person.id;
      noteEditor(draft, person.id);
      touch(policyOf(appendix.policyId));
      return view(person, appendix);
    },
    reorderAppendices: (
      _root,
      given: { orderedIds: string[]; policyVersionId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const version = versionPolicy(given.policyVersionId);
      const policy = editablePolicy(person, version.policyId);
      const live = liveAppendices(data().appendices, policy.id);
      if (
        given.orderedIds.length !== live.length ||
        !live.every((a) => given.orderedIds.includes(a.id))
      )
        throw refuse(
          "BAD_USER_INPUT",
          "Name every appendix of this version exactly once.",
        );
      for (const [index, id] of given.orderedIds.entries())
        appendixById(id).orderIndex = index;
      touch(policy);
      return liveAppendices(data().appendices, policy.id).map((a) =>
        legacyShape(a, version.id),
      );
    },
    reorderPolicyAppendices: (
      _root,
      given: { orderedIds: string[]; policyId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const policy = editablePolicy(person, given.policyId);
      const all = data().appendices;
      const live = liveAppendices(all, policy.id);
      if (
        given.orderedIds.length !== live.length ||
        !live.every((a) => given.orderedIds.includes(a.id))
      )
        throw refuse(
          "BAD_USER_INPUT",
          "Name every appendix of this document exactly once.",
        );
      for (const [index, id] of given.orderedIds.entries())
        appendixById(id).orderIndex = index;
      touch(policy);
      return liveAppendices(all, policy.id).map((a) => view(person, a));
    },
    restoreAppendix: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      const appendix = editable(person, given.id);
      const all = data().appendices;
      appendix.retiredAt = null;
      appendix.retiredBy = null;
      appendix.orderIndex = liveAppendices(all, appendix.policyId).length;
      renumber(all, appendix.policyId);
      touch(policyOf(appendix.policyId));
      return view(person, appendix);
    },
    retireAppendix: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      const appendix = editable(person, given.id);
      appendix.retiredAt = now();
      appendix.retiredBy = person.id;
      renumber(data().appendices, appendix.policyId);
      touch(policyOf(appendix.policyId));
      return view(person, appendix);
    },
    saveAppendixDraft: (
      _root,
      given: { contentJson: string; id: string; title: string },
      context: Context,
    ) => {
      const person = caller(context);
      const appendix = editable(person, given.id);
      if (given.title.trim() === "")
        throw refuse("BAD_USER_INPUT", "An appendix needs a title.");
      const at = now();
      const draft = draftOf(appendix);
      if (draft) {
        draft.title = given.title;
        draft.contentJson = given.contentJson;
        draft.updatedAt = at;
        draft.updatedBy = person.id;
        noteEditor(draft, person.id);
      } else if (
        // Only a title or content change makes a draft (bug log 246).
        latestPublished(appendix)?.title !== given.title ||
        latestPublished(appendix)?.contentJson !== given.contentJson
      ) {
        appendix.versions.push({
          contentJson: given.contentJson,
          createdAt: at,
          createdBy: person.id,
          editors: [person.id],
          id: `${appendix.id}-v${String(appendix.versions.length + 1)}`,
          publishedAt: null,
          publishedBy: null,
          state: "DRAFT",
          title: given.title,
          updatedAt: at,
          updatedBy: person.id,
          versionNo: appendix.versions.length + 1,
        });
      }
      touch(policyOf(appendix.policyId));
      return view(person, appendix);
    },
    updateAppendix: (
      _root,
      given: { contentJson: string; id: string; title: string },
      context: Context,
    ) => {
      const person = caller(context);
      const appendix = editable(person, given.id);
      const at = now();
      appendix.versions.push({
        contentJson: given.contentJson,
        createdAt: at,
        createdBy: person.id,
        editors: [person.id],
        id: `${appendix.id}-v${String(appendix.versions.length + 1)}`,
        publishedAt: at,
        publishedBy: person.id,
        state: "PUBLISHED",
        title: given.title,
        updatedAt: at,
        updatedBy: person.id,
        versionNo: appendix.versions.length + 1,
      });
      const open = draftOf(appendix);
      if (open && open.state === "DRAFT")
        appendix.versions.splice(appendix.versions.indexOf(open), 1);
      touch(policyOf(appendix.policyId));
      const version = data().versions.find(
        (v) => v.policyId === appendix.policyId,
      );
      return legacyShape(appendix, version?.id ?? "");
    },
  },
  Query: {
    appendixDiff: (
      _root,
      given: { contentJson?: null | string; id: string },
      context: Context,
    ) => {
      const person = caller(context);
      const appendix = appendixById(given.id);
      const policy = readablePolicy(person, appendix.policyId);
      if (!mayDiff(person, policy)) throw forbidden();
      const draft = draftOf(appendix);
      const published = latestPublished(appendix);
      const from = sectionsOf(published?.contentJson ?? "");
      // Text that is not saved yet (what the author is typing) stands in for the stored draft.
      const to = sectionsOf(
        given.contentJson ?? draft?.contentJson ?? published?.contentJson ?? "",
      );
      const keys = [...new Set([...to.keys(), ...from.keys()])];
      return (
        diffVersions(
          envelope(from),
          envelope(to),
          keys.map((key) => ({ key, title: key })),
          false,
        ) ?? []
      );
    },
    policyAppendices: (
      _root,
      given: { includeRetired?: boolean; policyId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const policy = readablePolicy(person, given.policyId);
      const editor = mayRead(person, policy);
      return appendicesOf(data().appendices, policy.id)
        .filter(
          (a) =>
            (given.includeRetired === true && editor) || a.retiredAt === null,
        )
        .filter((a) => editor || latestPublished(a))
        .map((a) => view(person, a));
    },
    policyAppendix: (_root, given: { id: string }, context: Context) => {
      const person = caller(context);
      const appendix = appendixById(given.id);
      readablePolicy(person, appendix.policyId);
      return view(person, appendix);
    },
  },
};
