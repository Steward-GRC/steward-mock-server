// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Approval runs, as steward-workflow keeps them. submitWorkflow starts a run on the policy's own
// workflow or its home category's (steward-workflow doesn't look at ancestors), with a seat per
// approver on each stage. The caller's pending seats on the current stage are their tasks. An
// approval that meets the stage's quorum moves the run on, and the last stage's publishes the
// version; a rejection ends the run, the other seats and the version; a seat decides once.

import type { StewardPerson } from "#product/data/people.ts";
import type { Run, RunGroup, RunStage } from "#product/data/policies.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { canEdit } from "#product/access.ts";
import {
  cancelRuns,
  publishVersion,
  versionSubject,
} from "#product/resolvers/policies.ts";
import {
  caller,
  data,
  forbidden,
  found,
  newId,
  now,
  personOf,
  record,
  refuse,
} from "#product/resolvers/shared.ts";

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

/** Approvals a stage needs: one, a majority, or all of its seats. */
const required = (stage: RunStage): number => {
  const seats = stage.seats.length;
  if (stage.quorum === "all") return seats;
  if (stage.quorum === "majority") return Math.floor(seats / 2) + 1;
  return 1;
};

const unitOf = (stage: RunStage, group: RunGroup) => {
  const members = stage.seats.filter((s) => s.groupId === group.id);
  const approvals = members.filter((s) => s.state === "approved").length;
  const rejected = members.filter((s) => s.state === "rejected").length;
  let status = "PENDING";
  if (approvals >= group.required) status = "SATISFIED";
  else if (members.length - rejected < group.required) status = "REJECTED";
  return {
    approvals,
    groupId: group.id,
    groupName: group.name,
    pending: members.filter((s) => s.state === "pending").length,
    quorum: group.quorum,
    required: group.required,
    roster: members.length,
    status,
  };
};

/** The stage's own rule applies to its individual seats; each group needs its own quorum. */
const stageMet = (stage: RunStage): boolean => {
  const single = stage.seats.filter((s) => !s.groupId);
  const needed = required({ ...stage, seats: single });
  const singlesMet =
    single.length === 0 ||
    single.filter((s) => s.state === "approved").length >= needed;
  return (
    singlesMet &&
    (stage.groups ?? []).every((g) => unitOf(stage, g).status === "SATISFIED")
  );
};

/** Seats nobody needs any more once a stage or the run is settled. */
const closePending = (stages: RunStage[]) => {
  for (const stage of stages)
    for (const seat of stage.seats)
      if (seat.state === "pending") seat.state = "cancelled";
};

const partsOf = (run: Run) => {
  const policy = found(
    data().policies.find((p) => p.id === run.policyId),
    "policy",
  );
  const version = found(
    data().versions.find((v) => v.id === run.policyVersionId),
    "policy version",
  );
  return { policy, version };
};

/** Move a run on after an approval: the next stage, or publish after the last. */
const advance = (run: Run, person: StewardPerson) => {
  const stage = run.stages[run.currentStageIdx];
  if (!stage) return;
  if (!stageMet(stage)) return;
  closePending([stage]);
  if (run.currentStageIdx < run.stages.length - 1) {
    run.currentStageIdx += 1;
    return;
  }
  const { policy, version } = partsOf(run);
  run.status = "APPROVAL_STATUS_PUBLISHED";
  publishVersion(policy, version);
  record("policy.status_set", person, versionSubject(policy, version.id));
};

const reject = (run: Run) => {
  closePending(run.stages);
  run.status = "APPROVAL_STATUS_REJECTED";
  partsOf(run).version.status = "REJECTED";
};

const withdraw = (run: Run) => {
  closePending(run.stages);
  run.status = "APPROVAL_STATUS_WITHDRAWN";
  partsOf(run).version.status = "DRAFT";
};

const openRunFor = (policyVersionId: string): Run => {
  const run = runFor(policyVersionId);
  if (run?.status !== IN_REVIEW)
    throw refuse(
      "FAILED_PRECONDITION",
      "This approval is no longer active; refresh your inbox.",
    );
  return run;
};

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
      if (given.signal === "SIGNAL_TYPE_WITHDRAW") {
        const run = openRunFor(given.policyVersionId);
        withdraw(run);
        record(
          "workflow.withdrawn",
          person,
          versionSubject(partsOf(run).policy, partsOf(run).version.id),
        );
        return true;
      }
      if (given.signal === "SIGNAL_TYPE_REQUEST_CHANGES") {
        // steward-workflow records no seat for it; the stage stays pending.
        const run = openRunFor(given.policyVersionId);
        record(
          "workflow.signal.request_changes",
          person,
          versionSubject(partsOf(run).policy, partsOf(run).version.id),
        );
        return true;
      }
      if (!SIGNALS_NEEDING_COMMENT.has(given.signal))
        throw refuse("BAD_USER_INPUT", `${given.signal} isn't a decision.`);
      const { run, seat } = pendingSeatOf(person, given.policyVersionId);
      const approve = given.signal === "SIGNAL_TYPE_APPROVE";
      seat.state = approve ? "approved" : "rejected";
      seat.comment = given.comment;
      seat.decidedAt = now();
      record(
        approve ? "workflow.decision.approved" : "workflow.decision.rejected",
        person,
        versionSubject(partsOf(run).policy, partsOf(run).version.id),
      );
      if (approve) advance(run, person);
      else reject(run);
      return true;
    },
    submitWorkflow: (
      _root,
      given: { policyId: string; policyVersionId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const policy = found(
        data().policies.find((p) => p.id === given.policyId),
        "policy",
      );
      if (!canEdit(person, policy)) throw forbidden();
      const version = data().versions.find(
        (v) => v.id === given.policyVersionId && v.policyId === policy.id,
      );
      if (!version || policy.currentDraftVersionId !== version.id)
        throw refuse(
          "FAILED_PRECONDITION",
          "Only the policy's current draft can go for review.",
        );
      const home = data().categories.find(
        (c) => c.id === policy.homeCategoryId,
      );
      const workflowId = policy.workflowDefId ?? home?.defaultWorkflowId;
      const workflow = data().workflowDefs.find(
        (w) => w.id === workflowId && !w.archived,
      );
      if (!workflow)
        throw refuse(
          "FAILED_PRECONDITION",
          "No approval workflow is attached to this policy's category.",
        );
      const unstaffed = workflow.stages.find((s) => s.approvers.length === 0);
      if (unstaffed)
        throw refuse(
          "FAILED_PRECONDITION",
          `The "${unstaffed.name}" stage has no approver.`,
        );
      cancelRuns(version.id);
      const run: Run = {
        currentStageIdx: 0,
        id: newId("run"),
        policyId: policy.id,
        policyVersionId: version.id,
        stages: workflow.stages.map((stage) => ({
          name: stage.name,
          quorum: stage.quorum,
          seats: stage.approvers.map((userId) => ({
            comment: null,
            decidedAt: null,
            state: "pending",
            taskId: newId("task"),
            userId,
          })),
        })),
        status: IN_REVIEW,
        submittedAt: now(),
        submittedBy: person.id,
        workflowDefId: workflow.id,
      };
      data().runs.push(run);
      version.status = "IN_REVIEW";
      policy.updatedAt = run.submittedAt;
      record("workflow.submitted", person, versionSubject(policy, version.id));
      return { runId: run.id };
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
            groupId: s.groupId ?? null,
            name: personOf(s.userId)?.name ?? null,
            state: s.state,
            userId: s.userId,
          })),
        ),
        stageNames: run.stages.map((stage) => stage.name),
        stageUnitProgress: run.stages.map((stage) =>
          (stage.groups ?? []).map((g) => unitOf(stage, g)),
        ),
        status: run.status,
      };
    },
  },
};
