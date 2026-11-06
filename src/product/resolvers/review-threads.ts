// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Inline review comment threads on a policy version, ahead of the gateway (gateway#79, core#33).
// Approvers on a version's run, the policy's authors and site admins take part; anyone who can
// read the version sees the threads, without message bodies when their view is obfuscated.

import type { StewardPerson } from "#product/data/people.ts";
import type { PolicyVersion } from "#product/data/policies.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { canEdit, readableVersion, readEffect } from "#product/access.ts";
import {
  caller,
  data,
  forbidden,
  found,
  isSiteAdmin,
  newId,
  now,
  personOf,
  refuse,
} from "#product/resolvers/shared.ts";

export interface ReviewMessage {
  authorUserId: string;
  body: string;
  createdAt: string;
  id: string;
}

export interface ReviewThread {
  createdAt: string;
  id: string;
  messages: ReviewMessage[];
  occurrence: number;
  policyVersionId: string;
  quote: string;
  resolved: boolean;
}

const versionOf = (id: string): PolicyVersion =>
  found(
    data().versions.find((v) => v.id === id),
    "policy version",
  );

/** Whoever may start threads and reply: a seat on the version's run, an author, a site admin. */
const takesPart = (person: StewardPerson, version: PolicyVersion): boolean => {
  const policy = found(
    data().policies.find((p) => p.id === version.policyId),
    "policy",
  );
  if (isSiteAdmin(person) || canEdit(person, policy)) return true;
  return data().runs.some(
    (run) =>
      run.policyVersionId === version.id &&
      run.stages.some((stage) =>
        stage.seats.some((s) => s.userId === person.id),
      ),
  );
};

/** The version, if the caller may read it; a hidden version looks like a missing one. */
const readable = (person: StewardPerson, versionId: string): PolicyVersion => {
  const version = versionOf(versionId);
  if (!readableVersion(person, version)) throw forbidden();
  return version;
};

const participant = (
  person: StewardPerson,
  versionId: string,
): PolicyVersion => {
  const version = readable(person, versionId);
  if (!takesPart(person, version)) throw forbidden();
  return version;
};

const threadOf = (id: string): ReviewThread =>
  found(
    data().reviewThreads.find((t) => t.id === id),
    "review thread",
  );

const present = (person: StewardPerson, thread: ReviewThread) => {
  const version = versionOf(thread.policyVersionId);
  const policy = data().policies.find((p) => p.id === version.policyId);
  const hidden = !policy || readEffect(person, policy) === "obfuscate";
  return {
    ...thread,
    messages: thread.messages.map((m) => ({
      ...m,
      authorName: personOf(m.authorUserId)?.name ?? null,
      body: hidden ? "" : m.body,
    })),
  };
};

const message = (person: StewardPerson, body: string): ReviewMessage => {
  const text = body.trim();
  if (!text) throw refuse("BAD_USER_INPUT", "A comment can't be empty.");
  return {
    authorUserId: person.id,
    body: text,
    createdAt: now(),
    id: newId("review-message"),
  };
};

export const reviewThreadResolvers: Resolvers = {
  Mutation: {
    addReviewThread: (
      _root,
      given: {
        body: string;
        occurrence: number;
        policyVersionId: string;
        quote: string;
      },
      context: Context,
    ) => {
      const person = caller(context);
      participant(person, given.policyVersionId);
      if (!given.quote.trim())
        throw refuse("BAD_USER_INPUT", "Select some text to comment on.");
      if (given.occurrence < 1)
        throw refuse("BAD_USER_INPUT", "occurrence counts from 1.");
      const thread: ReviewThread = {
        createdAt: now(),
        id: newId("review-thread"),
        messages: [message(person, given.body)],
        occurrence: given.occurrence,
        policyVersionId: given.policyVersionId,
        quote: given.quote,
        resolved: false,
      };
      data().reviewThreads.push(thread);
      return present(person, thread);
    },
    deleteReviewThread: (
      _root,
      given: { threadId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const thread = threadOf(given.threadId);
      participant(person, thread.policyVersionId);
      if (thread.messages[0]?.authorUserId !== person.id) throw forbidden();
      data().reviewThreads = data().reviewThreads.filter(
        (t) => t.id !== thread.id,
      );
      return true;
    },
    replyReviewThread: (
      _root,
      given: { body: string; threadId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const thread = threadOf(given.threadId);
      participant(person, thread.policyVersionId);
      thread.messages.push(message(person, given.body));
      return present(person, thread);
    },
    setReviewThreadResolved: (
      _root,
      given: { resolved: boolean; threadId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const thread = threadOf(given.threadId);
      participant(person, thread.policyVersionId);
      thread.resolved = given.resolved;
      return present(person, thread);
    },
  },
  Query: {
    reviewThreads: (
      _root,
      given: { policyVersionId: string },
      context: Context,
    ) => {
      const person = caller(context);
      readable(person, given.policyVersionId);
      return data()
        .reviewThreads.filter(
          (t) => t.policyVersionId === given.policyVersionId,
        )
        .map((t) => present(person, t));
    },
  },
};
