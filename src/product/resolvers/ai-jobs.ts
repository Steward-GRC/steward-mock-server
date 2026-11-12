// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// AI jobs on the mock. Real AI is tested on the appliance only; this simulates the async job
// framework so the AI screens can be walked against the mock: a submit returns a jobId, the job
// runs for a moment (aiJob reads Pending, then Running, then Succeeded; the aiJobResult
// subscription delivers the end), and aiJobResultContent returns a made-up result in the shape
// steward-ai writes: sections for a draft, findings for a review, a change set for a revision,
// proposals for enrichment, a summary for a changes or version summary. Every text says it is simulated. The simulation control that turns
// Ask off turns the jobs off with it (resolvers/ai.ts).

import type { Context } from "#core/graphql.ts";

import { caller, notFound, now } from "#product/resolvers/shared.ts";

export type JobOperation =
  | "DRAFT"
  | "REVIEW"
  | "REVISE"
  | "SUGGEST_ENRICHMENTS"
  | "SUMMARIZE";

interface Job {
  /** The cached content has expired, as after the gateway's result cache ages out (about 24 h). */
  expired?: boolean;
  id: string;
  operation: JobOperation;
  owner: string;
  result: string;
  startedAt: number;
}

const NOTE = "Simulated, not from a real AI. ";
const jobs = new Map<string, Job>();
let counter = 0; // never reset: a job id is not reused after a reset of the data
let duration = Number(process.env.MOCK_AI_JOB_MS ?? 2500);

/** How long a job runs before it succeeds; tests set it small. */
export const setJobDuration = (ms: number): void => {
  duration = ms;
};

interface SectionIn {
  content?: null | string;
  guidance?: null | string;
  key: string;
  title: string;
}

const draftResult = (input: {
  brief: string;
  sections: SectionIn[];
  title?: null | string;
}) => ({
  sections: input.sections.map((section) => ({
    content: `${NOTE}${section.title}: ${input.brief}${section.guidance ? ` ${section.guidance}` : ""}`,
    sectionKey: section.key,
  })),
});

const reviewResult = (input: { sections: SectionIn[] }) => {
  const findings = input.sections.flatMap((section) => {
    const length = (section.content ?? "").trim().length;
    if (length === 0)
      return [
        {
          finding: `${NOTE}${section.title} has no content.`,
          sectionKey: section.key,
          severity: "blocker",
          suggestion:
            "Say what the section covers before this goes to approval.",
        },
      ];
    if (length < 120)
      return [
        {
          finding: `${NOTE}${section.title} is short and may leave gaps.`,
          sectionKey: section.key,
          severity: "warn",
          suggestion:
            "Add who is responsible and what happens when the rule is not met.",
        },
      ];
    return [];
  });
  return {
    findings: [
      ...findings,
      {
        finding: `${NOTE}Check that each section names an owner and a review date.`,
        severity: "info",
      },
    ],
  };
};

const reviseResult = (input: {
  instruction: string;
  sections: SectionIn[];
}) => ({
  newSections: [],
  sections: input.sections.map((section, index) =>
    index === 0
      ? {
          changed: true,
          content:
            `${section.content ?? ""} ${NOTE}Revised as asked: ${input.instruction}`.trim(),
          removed: false,
          sectionKey: section.key,
        }
      : { changed: false, removed: false, sectionKey: section.key },
  ),
});

const enrichResult = (input: {
  enrichmentOptOut?: {
    definitions?: boolean;
    references?: boolean;
    related?: boolean;
  } | null;
}) => ({
  suggestions: {
    definitions: input.enrichmentOptOut?.definitions
      ? []
      : [
          {
            action: "create_new",
            definition: `${NOTE}A term this document uses.`,
            term: "Sample term",
          },
        ],
    references: [],
    related: [],
  },
});

const BUILDERS: Record<JobOperation, (input: never) => unknown> = {
  DRAFT: draftResult,
  REVIEW: reviewResult,
  REVISE: reviseResult,
  SUGGEST_ENRICHMENTS: enrichResult,
  // The summary is made by the resolver, which has already checked the read (resolvers/ai-summaries.ts).
  SUMMARIZE: (input: { result: unknown }) => input.result,
};

/** Starts a job for the caller and returns its id. */
export const submitJob = (
  operation: JobOperation,
  input: unknown,
  context: Context,
): { jobId: string } => {
  const owner = caller(context).id;
  counter += 1;
  const id = `ai-job-${counter}`;
  jobs.set(id, {
    id,
    operation,
    owner,
    result: JSON.stringify(BUILDERS[operation](input as never)),
    startedAt: Date.now(),
  });
  return { jobId: id };
};

const jobOf = (jobId: string, context: Context): Job => {
  const job = jobs.get(jobId);
  if (!job || job.owner !== caller(context).id) throw notFound("The job");
  return job;
};

const referenceOf = (job: Job) => `mock-ai-result:${job.id}`;

const phaseOf = (job: Job) => {
  const elapsed = Date.now() - job.startedAt;
  if (elapsed >= duration) return "AI_JOB_PHASE_SUCCEEDED";
  return elapsed >= duration / 4
    ? "AI_JOB_PHASE_RUNNING"
    : "AI_JOB_PHASE_PENDING";
};

/** aiJob: the job's phase; the result ref once it has succeeded. */
export const jobStatus = (jobId: string, context: Context) => {
  const job = jobOf(jobId, context);
  const phase = phaseOf(job);
  const done = phase === "AI_JOB_PHASE_SUCCEEDED";
  return {
    error: null,
    finishedAt: done ? new Date(job.startedAt + duration).toISOString() : null,
    jobId: job.id,
    phase,
    resultRef: done ? referenceOf(job) : null,
    startedAt:
      phase === "AI_JOB_PHASE_PENDING"
        ? null
        : new Date(job.startedAt).toISOString(),
  };
};

/** Test helper: ages the job's cached content out, as the gateway's result cache does after about 24 h. */
export const expireJobContent = (jobId: string): void => {
  const job = jobs.get(jobId);
  if (job) job.expired = true;
};

/**
 * aiJobResultContent: what the job produced, once it has succeeded. A ref whose content has expired
 * is not found, unless the caller also names the job: then the stored result of the caller's own
 * finished job is served. A cache hit ignores the jobId.
 */
export const jobContent = (
  resultReference: string,
  context: Context,
  jobId?: null | string,
) => {
  const owner = caller(context).id;
  const cached = [...jobs.values()].find(
    (candidate) => referenceOf(candidate) === resultReference,
  );
  const fallback = jobId ? jobs.get(jobId) : undefined;
  const job = cached && !cached.expired ? cached : fallback;
  if (!job || job.owner !== owner || phaseOf(job) !== "AI_JOB_PHASE_SUCCEEDED")
    throw notFound("The result");
  return { operation: job.operation, resultJson: job.result };
};

/** The aiJobResult stream: the job's end, sent once it has run. An unknown job is refused at once. */
export const jobEnd = (jobId: string, context: Context) => {
  const job = jobOf(jobId, context);
  return (async function* () {
    const wait = job.startedAt + duration - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    yield {
      error: null,
      finishedAt: now(),
      jobId: job.id,
      phase: "AI_JOB_PHASE_SUCCEEDED",
      resultRef: referenceOf(job),
    };
  })();
};
