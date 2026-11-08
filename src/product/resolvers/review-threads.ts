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

export interface ReviewSuggestion {
  closedBy: null | string;
  closedText: null | string;
  outcome: null | SuggestionOutcome;
  reason: null | string;
  rounds: SuggestionRound[];
  text: string;
  turn: SuggestionSide;
}
export interface ReviewThread {
  createdAt: string;
  id: string;
  messages: ReviewMessage[];
  occurrence: number;
  policyVersionId: string;
  quote: string;
  resolved: boolean;
  suggestion?: null | ReviewSuggestion;
}

export type SuggestionOutcome =
  | "AGREED"
  | "CHANGED"
  | "NOT_AGREED"
  | "REMOVED"
  | "WITHDRAWN";

export interface SuggestionRound {
  by: SuggestionSide;
  createdAt: string;
  text: string;
  userId: string;
}

export type SuggestionSide = "AUTHOR" | "REVIEWER";

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

/** Like a message body, proposed text is not shown to a reader whose view is obfuscated. */
const hideSuggestion = (
  suggestion: null | ReviewSuggestion | undefined,
): null | ReviewSuggestion =>
  suggestion
    ? {
        ...suggestion,
        closedText: null,
        rounds: suggestion.rounds.map((round) => ({ ...round, text: "" })),
        text: "",
      }
    : null;

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
    suggestion: hidden
      ? hideSuggestion(thread.suggestion)
      : (thread.suggestion ?? null),
  };
};

/** Which side the caller acts on: an author of the policy, or otherwise a reviewer. */
const sideOf = (
  person: StewardPerson,
  thread: ReviewThread,
): SuggestionSide => {
  const version = versionOf(thread.policyVersionId);
  const policy = found(
    data().policies.find((p) => p.id === version.policyId),
    "policy",
  );
  return canEdit(person, policy) ? "AUTHOR" : "REVIEWER";
};

const other = (side: SuggestionSide): SuggestionSide =>
  side === "AUTHOR" ? "REVIEWER" : "AUTHOR";

/** A suggestion that is still open, on the caller's turn when `onTurn`. */
const openSuggestion = (
  person: StewardPerson,
  thread: ReviewThread,
  onTurn: boolean,
): ReviewSuggestion => {
  const suggestion = thread.suggestion;
  if (!suggestion)
    throw refuse("FAILED_PRECONDITION", "That thread has no suggestion.");
  if (suggestion.outcome)
    throw refuse("FAILED_PRECONDITION", "That suggestion has ended.");
  if (onTurn && suggestion.turn !== sideOf(person, thread))
    throw refuse("FAILED_PRECONDITION", "It is not your turn to answer.");
  return suggestion;
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
        suggestedText?: null | string;
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
      const proposed = given.suggestedText?.trim();
      if (proposed && proposed !== given.quote.trim()) {
        const side = sideOf(person, thread);
        thread.suggestion = {
          closedBy: null,
          closedText: null,
          outcome: null,
          reason: null,
          rounds: [
            { by: side, createdAt: now(), text: proposed, userId: person.id },
          ],
          text: proposed,
          turn: other(side),
        };
      }
      data().reviewThreads.push(thread);
      return present(person, thread);
    },
    closeReviewSuggestion: (
      _root,
      given: {
        outcome: SuggestionOutcome;
        reason?: null | string;
        threadId: string;
      },
      context: Context,
    ) => {
      const person = caller(context);
      const thread = threadOf(given.threadId);
      participant(person, thread.policyVersionId);
      const suggestion = openSuggestion(person, thread, false);
      const side = sideOf(person, thread);
      const mine = suggestion.turn === side;
      const reason = given.reason?.trim() ?? "";
      const allowed: Record<SuggestionOutcome, boolean> = {
        AGREED: mine && side === "REVIEWER",
        CHANGED: mine && side === "AUTHOR",
        NOT_AGREED: mine,
        REMOVED: mine && side === "AUTHOR",
        WITHDRAWN: !mine && suggestion.rounds[0]?.by === side,
      };
      if (!allowed[given.outcome])
        throw refuse(
          "FAILED_PRECONDITION",
          "That outcome is not yours to choose now.",
        );
      if (given.outcome === "NOT_AGREED" && !reason)
        throw refuse("BAD_USER_INPUT", "Say why it is not agreed.");
      suggestion.outcome = given.outcome;
      suggestion.reason = reason || null;
      suggestion.closedBy = person.id;
      suggestion.closedText = suggestion.text;
      thread.resolved = true;
      return present(person, thread);
    },
    counterReviewSuggestion: (
      _root,
      given: { text: string; threadId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const thread = threadOf(given.threadId);
      participant(person, thread.policyVersionId);
      const suggestion = openSuggestion(person, thread, true);
      const text = given.text.trim();
      if (!text) throw refuse("BAD_USER_INPUT", "A counter can't be empty.");
      const side = sideOf(person, thread);
      suggestion.rounds.push({
        by: side,
        createdAt: now(),
        text,
        userId: person.id,
      });
      suggestion.text = text;
      suggestion.turn = other(side);
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
