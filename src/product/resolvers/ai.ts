// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Steward AI isn't part of the mock. Ask (resolvers/ask.ts) and the async jobs (resolvers/ai-jobs.ts:
// draft, review, revision and enrichment) are simulated while the simulation is on, which it is by
// default: aiHealth says available, searchAndAnswer answers from what the caller may read,
// topPolicyQuestions lists the questions asked, and a submitted job runs and returns a made-up
// result. Everything else, and all of it with the simulation off, answers the way steward-gateway
// does when the ai service is unreachable.
// aiHealth says so; the reads that swallow an ai error (topPolicyQuestions,
// relatedPolicySuggestions, policyVersionSummary) answer empty (policyVersionSummary otherwise serves
// the summary regenerateVersionSummary stored, see resolvers/ai-summaries.ts); everything else checks the caller as
// the gateway does, then fails as a transport fault, which the gateway presents as INTERNAL with
// its generic message.
// The settings reads (aiConfig, aiRetrievalConfig) answer a default config for a site admin while
// the simulation is on; the settings changes are not stored and stay refused as the unreachable
// service, except setAIMonthlyLimit, which is kept (aiConfig.monthlyLimit reads it back; 0 means no
// limit). It is a number only: nothing counts usage against it, so reaching it is the ai-limit
// control's limit_reached. The reasons aiHealth gives while the service answers: provider_unavailable with ai's
// providerReason (auth_failed, provider_error, not_configured, or jobs_unavailable when ai has no
// Kubernetes API, which also fails the job submits as a transport fault), and limit_reached when
// the organisation's monthly limit or the caller's daily limit is hit (the submits then refuse
// with FailedPrecondition). The /_mock controls ai-provider and ai-limit switch them.

import type { GraphQLError } from "graphql";

import { type Context, type Resolvers, signedIn } from "#core/graphql.ts";
import { canAuthorIn } from "#product/access.ts";
import {
  jobContent,
  jobEnd,
  type JobOperation,
  jobStatus,
  submitJob,
} from "#product/resolvers/ai-jobs.ts";
import {
  regenerateVersionSummary,
  storedVersionSummary,
  summarizeChanges,
  type Summary,
} from "#product/resolvers/ai-summaries.ts";
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

/** The default settings a site admin reads while the simulation is on; nothing changes them. */
const DEFAULT_TOP_K = 50;
const defaultConfig = () => ({
  baseUrl: "",
  credentialLast4: "",
  credentialSet: false,
  dataNotice: {
    acceptedAt: null,
    acceptedBy: null,
    acceptedVersion: "",
    currentVersion: "1",
  },
  deployment: "",
  enabled: true,
  model: "",
  monthlyLimit: data().aiMonthlyLimit,
  provider: null,
  region: "",
  topK: DEFAULT_TOP_K,
});

/**
 * setAIMonthlyLimit: site admin only. While simulated the limit is kept and the limit in force is
 * answered; a negative one is InvalidArgument (the gateway refuses it before ai is asked), 0 clears
 * it. With the simulation off it is the unreachable service, like the other settings changes.
 */
const setMonthlyLimit = (
  root: unknown,
  given: { limit: number },
  context: Context,
): number => {
  if (!data().aiSimulated) return adminDown(root, given, context);
  siteAdmin(context);
  if (given.limit < 0)
    throw refuse("BAD_USER_INPUT", "The monthly limit cannot be negative.");
  data().aiMonthlyLimit = given.limit;
  return data().aiMonthlyLimit;
};

/** A settings read: the default config for a site admin while simulated, else the service is down. */
const settingsRead =
  <Result>(read: () => Result) =>
  (root: unknown, given: unknown, context: Context): Result => {
    if (!data().aiSimulated) return adminDown(root, given, context);
    siteAdmin(context);
    return read();
  };

/**
 * Why a job submit fails before its category check, when ai is up but cannot take it: no
 * Kubernetes API for jobs (ai's reach fault, so the gateway's generic INTERNAL), or a usage limit
 * (a FailedPrecondition the person is told about).
 */
const submitBlocked = (): GraphQLError | null => {
  if (data().aiProviderOutage === "jobs_unavailable") return unreachable();
  if (data().aiLimitReached)
    return refuse(
      "FAILED_PRECONDITION",
      "The AI usage limit has been reached. Try again later.",
    );
  return null;
};

/** The longest CUSTOM framing wording, in characters (steward-gateway internal/resolvers/framing.go). */
const MAX_CUSTOM_FRAMING = 500;

/**
 * The draft and revision submits take a framing and, for CUSTOM, the author's own wording. The
 * gateway checks it after the category check and before it asks ai for a job: CUSTOM needs
 * wording that is not blank and at most 500 characters once trimmed; wording sent with another
 * framing, or none, is dropped. The gateway returns a plain error for a bad one, which it presents
 * as its generic fault, so the mock refuses with INTERNAL too. The framing changes nothing in the
 * made-up result.
 */
const checkFraming = (input: {
  customFraming?: null | string;
  framing?: null | string;
}): void => {
  if (input.framing !== "CUSTOM") return;
  const wording = (input.customFraming ?? "").trim();
  if (wording === "" || [...wording].length > MAX_CUSTOM_FRAMING)
    throw unreachable();
};

/** A job submission: simulated while the simulation is on, and checked the same way either way. */
const submitting =
  (operation: JobOperation) =>
  (
    root: unknown,
    given: {
      input: {
        categoryId?: null | string;
        customFraming?: null | string;
        framing?: null | string;
      };
    },
    context: Context,
  ) => {
    if (!data().aiSimulated) return submitDown(root, given, context);
    const person = caller(context);
    const categoryId = given.input.categoryId;
    if (categoryId && !canAuthorIn(person, categoryId)) throw forbidden();
    checkFraming(given.input);
    const blocked = submitBlocked();
    if (blocked) throw blocked;
    return submitJob(operation, given.input, context);
  };

/**
 * A summary submit: the gateway checks the read first (NotFound, PermissionDenied, then nothing to
 * summarise), then submits the job, which fails when AI is off or cannot take it.
 */
const summarising =
  <Given>(plan: (person: ReturnType<typeof caller>, given: Given) => Summary) =>
  (_root: unknown, given: Given, context: Context) => {
    const summary = plan(caller(context), given);
    if (!data().aiSimulated) throw unreachable();
    const blocked = submitBlocked();
    if (blocked) throw blocked;
    summary.remember();
    return submitJob("SUMMARIZE", { result: summary.result }, context);
  };

/** A read of a job: simulated while the simulation is on. */
const reading =
  <Given, Result>(read: (given: Given, context: Context) => Result) =>
  (root: unknown, given: Given, context: Context): Result =>
    data().aiSimulated ? read(given, context) : down(root, given, context);

export const aiResolvers: Resolvers = {
  Mutation: {
    acceptAIDataNotice: adminDown,
    regenerateVersionSummary: summarising(regenerateVersionSummary),
    setAIEnabled: adminDown,
    setAIMonthlyLimit: setMonthlyLimit,
    setAIProviderConfig: adminDown,
    setAIProviderCredential: adminDown,
    setAIRetrievalConfig: adminDown,
    setUserAiQueryLimit: adminDown,
    submitDraftGeneration: submitting("DRAFT"),
    submitEnrichmentSuggestions: submitting("SUGGEST_ENRICHMENTS"),
    submitPolicyReview: submitting("REVIEW"),
    submitPolicyRevision: submitting("REVISE"),
    summarizeChanges: summarising(summarizeChanges),
    testAIProvider: adminDown,
  },
  Query: {
    aiConfig: settingsRead(defaultConfig),
    aiEnabled: down,
    aiHealth: () => {
      if (!data().aiSimulated)
        return {
          available: false,
          providerReason: null,
          reason: "ai_service_unavailable",
        };
      const outage = data().aiProviderOutage;
      // ai answers but its provider fails: providerReason is ai's own code, null when it gave none
      if (outage !== null)
        return {
          available: false,
          providerReason: outage || null,
          reason: "provider_unavailable",
        };
      // a usage limit holds while ai and its provider are otherwise fine
      if (data().aiLimitReached)
        return {
          available: false,
          providerReason: null,
          reason: "limit_reached",
        };
      return { available: true, providerReason: null, reason: null };
    },
    aiJob: reading((given: { jobId: string }, context) =>
      jobStatus(given.jobId, context),
    ),
    aiJobResultContent: reading(
      (given: { jobId?: null | string; resultRef: string }, context) =>
        jobContent(given.resultRef, context, given.jobId),
    ),
    aiRetrievalConfig: settingsRead(() => ({ topK: DEFAULT_TOP_K })),
    authoringAssist: down,
    policyVersionSummary: (
      _root,
      given: { versionId: string },
      context: Context,
    ) => {
      const person = caller(context);
      // With the ai service unreachable the gateway swallows the error and answers null.
      return data().aiSimulated
        ? storedVersionSummary(person, given.versionId)
        : null;
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
