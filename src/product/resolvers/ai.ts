// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward AI isn't part of the mock. Ask is simulated (resolvers/ask.ts) while the simulation is
// on, which it is by default: aiHealth says available, searchAndAnswer answers from what the
// caller may read and topPolicyQuestions lists the questions asked. Everything else, and Ask with
// the simulation off, answers the way steward-gateway does when the ai service is unreachable.
// aiHealth says so; the reads that swallow an ai error (topPolicyQuestions,
// relatedPolicySuggestions, policyVersionSummary) answer empty; everything else checks the caller as
// the gateway does, then fails as a transport fault, which the gateway presents as INTERNAL with
// its generic message.

import { type Context, type Resolvers, signedIn } from "#core/graphql.ts";
import { canAuthorIn } from "#product/access.ts";
import { simulatedAnswer, topQuestions } from "#product/resolvers/ask.ts";
import {
  caller,
  data,
  forbidden,
  refuse,
  siteAdmin,
} from "#product/resolvers/shared.ts";

/** The gateway's message for a fault on its side (internal/server/errors.go). */
const unreachable = () =>
  refuse("INTERNAL", "Something went wrong on our side. Please try again.");

/** A signed-in call whose ai request fails. */
const down = (_root: unknown, _given: unknown, context: Context): never => {
  signedIn(context);
  throw unreachable();
};

/** A site-admin call whose ai request fails. */
const adminDown = (
  _root: unknown,
  _given: unknown,
  context: Context,
): never => {
  siteAdmin(context);
  throw unreachable();
};

/** A job submission: checked against the category's authoring scope when it names one. */
const submitDown = (
  _root: unknown,
  given: { input: { categoryId?: null | string } },
  context: Context,
): never => {
  const person = caller(context);
  const categoryId = given.input.categoryId;
  if (categoryId && !canAuthorIn(person, categoryId)) throw forbidden();
  throw unreachable();
};

export const aiResolvers: Resolvers = {
  Mutation: {
    acceptAIDataNotice: adminDown,
    setAIEnabled: adminDown,
    setAIProviderConfig: adminDown,
    setAIProviderCredential: adminDown,
    setAIRetrievalConfig: adminDown,
    setUserAiQueryLimit: adminDown,
    submitDraftGeneration: submitDown,
    submitEnrichmentSuggestions: submitDown,
    submitPolicyReview: submitDown,
    submitPolicyRevision: submitDown,
    testAIProvider: adminDown,
  },
  Query: {
    aiConfig: adminDown,
    aiEnabled: down,
    aiHealth: () =>
      data().aiSimulated
        ? { available: true, reason: null }
        : { available: false, reason: "ai_service_unavailable" },
    aiJob: down,
    aiJobResultContent: down,
    aiRetrievalConfig: adminDown,
    authoringAssist: down,
    policyVersionSummary: (_root, _given, context: Context) => {
      signedIn(context);
      return null;
    },
    relatedPolicySuggestions: (_root, _given, context: Context) => {
      signedIn(context);
      return [];
    },
    searchAndAnswer: (root, given: { question: string }, context: Context) => {
      if (!data().aiSimulated) return down(root, given, context);
      return simulatedAnswer(caller(context), given.question);
    },
    topPolicyQuestions: (
      _root,
      given: { limit?: null | number },
      context: Context,
    ) => {
      signedIn(context);
      return data().aiSimulated ? topQuestions(given.limit ?? 6) : [];
    },
  },
  Subscription: {
    // No job can have been submitted, so the stream fails as the job lookup does.
    aiJobResult: { subscribe: down },
  },
};
