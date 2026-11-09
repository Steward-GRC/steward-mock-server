// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward AI isn't part of the mock. Ask (resolvers/ask.ts) and the async jobs (resolvers/ai-jobs.ts:
// draft, review, revision and enrichment) are simulated while the simulation is on, which it is by
// default: aiHealth says available, searchAndAnswer answers from what the caller may read,
// topPolicyQuestions lists the questions asked, and a submitted job runs and returns a made-up
// result. Everything else, and all of it with the simulation off, answers the way steward-gateway
// does when the ai service is unreachable.
// aiHealth says so; the reads that swallow an ai error (topPolicyQuestions,
// relatedPolicySuggestions, policyVersionSummary) answer empty; everything else checks the caller as
// the gateway does, then fails as a transport fault, which the gateway presents as INTERNAL with
// its generic message.

import { type Context, type Resolvers, signedIn } from "#core/graphql.ts";
import { canAuthorIn } from "#product/access.ts";
import {
  jobContent,
  jobEnd,
  type JobOperation,
  jobStatus,
  submitJob,
} from "#product/resolvers/ai-jobs.ts";
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

/** A job submission: simulated while the simulation is on, and checked the same way either way. */
const submitting =
  (operation: JobOperation) =>
  (
    root: unknown,
    given: { input: { categoryId?: null | string } },
    context: Context,
  ) => {
    if (!data().aiSimulated) return submitDown(root, given, context);
    const person = caller(context);
    const categoryId = given.input.categoryId;
    if (categoryId && !canAuthorIn(person, categoryId)) throw forbidden();
    return submitJob(operation, given.input, context);
  };

/** A read of a job: simulated while the simulation is on. */
const reading =
  <Given, Result>(read: (given: Given, context: Context) => Result) =>
  (root: unknown, given: Given, context: Context): Result =>
    data().aiSimulated ? read(given, context) : down(root, given, context);

export const aiResolvers: Resolvers = {
  Mutation: {
    acceptAIDataNotice: adminDown,
    setAIEnabled: adminDown,
    setAIProviderConfig: adminDown,
    setAIProviderCredential: adminDown,
    setAIRetrievalConfig: adminDown,
    setUserAiQueryLimit: adminDown,
    submitDraftGeneration: submitting("DRAFT"),
    submitEnrichmentSuggestions: submitting("SUGGEST_ENRICHMENTS"),
    submitPolicyReview: submitting("REVIEW"),
    submitPolicyRevision: submitting("REVISE"),
    testAIProvider: adminDown,
  },
  Query: {
    aiConfig: adminDown,
    aiEnabled: down,
    aiHealth: () =>
      data().aiSimulated
        ? { available: true, reason: null }
        : { available: false, reason: "ai_service_unavailable" },
    aiJob: reading((given: { jobId: string }, context) =>
      jobStatus(given.jobId, context),
    ),
    aiJobResultContent: reading((given: { resultRef: string }, context) =>
      jobContent(given.resultRef, context),
    ),
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
    aiJobResult: {
      subscribe: (root, given: { jobId: string }, context: Context) =>
        data().aiSimulated
          ? jobEnd(given.jobId, context)
          : down(root, given, context),
    },
  },
};
