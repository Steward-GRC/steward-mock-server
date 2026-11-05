// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Approval runs, as steward-workflow keeps them: each stage has a seat per approver, the caller's
// pending seats are their tasks, and a decision lands on the caller's own pending seat.

import type { StewardPerson } from "#product/data/people.ts";
import type { Run } from "#product/data/policies.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { caller, data, personOf, refuse } from "#product/resolvers/shared.ts";

const EMPTY_STATUS = {
  currentStageIdx: 0,
  runId: "",
  stageAssignees: [],
  stageNames: [],
  stageUnitProgress: [],
  status: "APPROVAL_STATUS_UNSPECIFIED",
};

const IN_REVIEW = "APPROVAL_STATUS_IN_REVIEW";

/** The run that answers for a version: an open one first, else the latest. */
export const runFor = (policyVersionId: string): Run | undefined => {
  const runs = data().runs.filter((r) => r.policyVersionId === policyVersionId);
  return runs.find((r) => r.status === IN_REVIEW) ?? runs.at(-1);
};

const titleOf = (policyId: string) =>
  data().policies.find((p) => p.id === policyId)?.title ?? "";

const openRuns = () => data().runs.filter((r) => r.status === IN_REVIEW);

/** The caller's pending seat on a version's open run, or the gateway's stale-inbox refusal. */
export const pendingSeatOf = (
  person: StewardPerson,
  policyVersionId: string,
) => {
  const run = runFor(policyVersionId);
  const stage =
    run?.status === IN_REVIEW ? run.stages[run.currentStageIdx] : undefined;
  const seat = stage?.seats.find(
    (s) => s.userId === person.id && s.state === "pending",
  );
  if (!run || !seat)
    throw refuse(
      "FAILED_PRECONDITION",
      "This approval is no longer active; refresh your inbox.",
    );
  return { run, seat };
};

const SIGNALS_NEEDING_COMMENT = new Set([
  "SIGNAL_TYPE_APPROVE",
  "SIGNAL_TYPE_REJECT",
]);

export const workflowResolvers: Resolvers = {
  Mutation: {
    signalWorkflow: (
      _root,
      given: { comment: string; policyVersionId: string; signal: string },
      context: Context,
    ) => {
      const person = caller(context);
      if (SIGNALS_NEEDING_COMMENT.has(given.signal) && !given.comment.trim())
        throw refuse(
          "BAD_USER_INPUT",
          "A comment is required for this decision.",
        );
      const { seat } = pendingSeatOf(person, given.policyVersionId);
      if (
        given.signal === "SIGNAL_TYPE_APPROVE" ||
        given.signal === "SIGNAL_TYPE_REJECT"
      ) {
        seat.state =
          given.signal === "SIGNAL_TYPE_APPROVE" ? "approved" : "rejected";
        seat.comment = given.comment;
        seat.decidedAt = new Date().toISOString();
      }
      return true;
    },
  },
  Query: {
    pendingTasks: (_root, _given, context: Context) => {
      const person = caller(context);
      return openRuns().flatMap((run) =>
        (run.stages[run.currentStageIdx]?.seats ?? [])
          .filter((s) => s.userId === person.id && s.state === "pending")
          .map((s) => ({
            dueAt: null,
            policyTitle: titleOf(run.policyId),
            policyVersionId: run.policyVersionId,
            runId: run.id,
            stageIndex: run.currentStageIdx,
            taskId: s.taskId,
          })),
      );
    },
    upcomingApprovals: (_root, _given, context: Context) => {
      const person = caller(context);
      return openRuns().flatMap((run) =>
        run.stages.flatMap((stage, index) =>
          index > run.currentStageIdx &&
          stage.seats.some((s) => s.userId === person.id)
            ? [
                {
                  policyTitle: titleOf(run.policyId),
                  policyVersionId: run.policyVersionId,
                  stageIndex: index,
                  stageName: stage.name,
                },
              ]
            : [],
        ),
      );
    },
    workflowStatus: (
      _root,
      given: { policyVersionId: string },
      context: Context,
    ) => {
      caller(context);
      const run = runFor(given.policyVersionId);
      if (!run) return EMPTY_STATUS;
      return {
        currentStageIdx: run.currentStageIdx,
        runId: run.id,
        stageAssignees: run.stages.map((stage) =>
          stage.seats.map((s) => ({
            comment: s.comment,
            decidedAt: s.decidedAt,
            groupId: null,
            name: personOf(s.userId)?.name ?? null,
            state: s.state,
            userId: s.userId,
          })),
        ),
        stageNames: run.stages.map((stage) => stage.name),
        stageUnitProgress: run.stages.map(() => []),
        status: run.status,
      };
    },
  },
};
