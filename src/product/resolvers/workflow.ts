// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Approval runs, as steward-workflow keeps them. submitWorkflow starts a run on the policy's own
// workflow or its home category's (steward-workflow doesn't look at ancestors), with a seat per
// approver on each stage: the individuals from the nearest approversByCategory entry on the
// category lineage, else the stage's approvers, and each group unit's members under its group. The caller's pending seats on the current stage are their tasks. An
// approval that meets the stage's quorum moves the run on, and the last stage's publishes the
// version; a rejection is a vote, and the rejects reaching the quorum end the run, the other seats
// and the version; a seat decides once.

import type { SiteWorkCalendar } from "#product/data/admin.ts";
import type { Workflow, WorkflowStage } from "#product/data/library.ts";
import type { StewardPerson } from "#product/data/people.ts";
import type {
  Policy,
  Run,
  RunGroup,
  RunStage,
} from "#product/data/policies.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { createLogger } from "#core/log.ts";
import { canEdit, readEffect } from "#product/access.ts";
import { hasContent } from "#product/content.ts";
import { globalSettings } from "#product/data/admin.ts";
import {
  cancelRuns,
  publishVersion,
  versionSubject,
} from "#product/resolvers/policies.ts";
import { readsCategory } from "#product/resolvers/raci.ts";
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
import { markReviewed } from "#product/review-snapshots.ts";
import { addWorkingDays } from "#product/workcal.ts";

const log = createLogger("steward-workflow");

const EMPTY_STATUS = {
  currentStageIdx: 0,
  runId: "",
  stageAssignees: [],
  stageNames: [],
  stageProgress: [],
  stageUnitProgress: [],
  status: "APPROVAL_STATUS_UNSPECIFIED",
};

const IN_REVIEW = "APPROVAL_STATUS_IN_REVIEW";

const MAX_LINEAGE = 16;

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

/** Approvals a stage needs: one, a majority, all of its seats, or the N of an nofm stage. */
const required = (stage: RunStage): number => {
  const seats = stage.seats.length;
  if (stage.quorum === "nofm") return stage.quorumN ?? 0;
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

/** The individual approvals a stage has and needs; group units keep their own tally. */
const individualProgress = (stage: RunStage) => {
  const single = stage.seats.filter((s) => !s.groupId);
  return {
    approvals: single.filter((s) => s.state === "approved").length,
    required: single.length === 0 ? 0 : required({ ...stage, seats: single }),
  };
};

/**
 * A stage's due date from the day it is entered: its SLA in working days on the run's calendar
 * (the site calendar pinned at submit; the default Monday to Friday UTC without one), none
 * without an SLA. The end of the Nth working day after the day of entry.
 */
const dueFrom = (
  entered: string,
  stage: RunStage,
  calendar: SiteWorkCalendar = globalSettings().workCalendar,
): null | string => {
  if (!stage.slaDays) return null;
  const due = addWorkingDays(
    {
      holidays: calendar.holidays.map((h) => h.date),
      timezone: calendar.timezone,
      weekdays: calendar.weekdays,
    },
    new Date(entered),
    stage.slaDays,
  ).toISOString();
  log.trace("stage due date", {
    due,
    slaDays: stage.slaDays,
    timezone: calendar.timezone,
  });
  return due;
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

/** The group units of a stage that have a member. */
const unitsWithMembers = (stage: WorkflowStage) =>
  stage.groupUnits.filter((g) => g.memberUserIds.length > 0).length;

/** steward-workflow's MeetsQuorum: nofm needs N votes, any other quorum one. */
const meetsQuorum = (stage: WorkflowStage, votes: number): boolean =>
  stage.quorum === "nofm" ? votes >= stage.quorumN : votes > 0;

/** The policy's category and its ancestors, home first (the gateway's lineage). */
const lineageOf = (categoryId: string): string[] => {
  const lineage: string[] = [];
  for (
    let at = data().categories.find((c) => c.id === categoryId);
    at && lineage.length < MAX_LINEAGE;
    at = data().categories.find((c) => c.id === at?.parentId)
  )
    lineage.push(at.id);
  return lineage;
};

/**
 * steward-workflow's eligibility.StagePool: the first category on the lineage with an
 * approversByCategory entry gives the stage's individual approvers; with no entry, or an empty
 * one, the stage's own approvers do.
 */
const poolOf = (stage: WorkflowStage, lineage: string[]): string[] => {
  for (const id of lineage) {
    const entry = stage.approversByCategory.find((c) => c.categoryId === id);
    if (entry)
      return entry.approverIds.length > 0 ? entry.approverIds : stage.approvers;
  }
  return stage.approvers;
};

/**
 * The workflow a policy goes through: its own, else its home category's, and never an archived
 * one (steward-workflow doesn't look at ancestors). submitWorkflow and effectiveWorkflow share it.
 */
const workflowOf = (policy: Policy) => {
  const home = data().categories.find((c) => c.id === policy.homeCategoryId);
  const workflowId = policy.workflowDefId ?? home?.defaultWorkflowId;
  return data().workflowDefs.find((w) => w.id === workflowId && !w.archived);
};

/** The first stage of the workflow with neither an approver pool nor a group with members. */
const unstaffedStageOf = (workflow: Workflow, policy: Policy) => {
  const lineage = lineageOf(policy.homeCategoryId);
  return workflow.stages.find(
    (s) => poolOf(s, lineage).length === 0 && unitsWithMembers(s) === 0,
  );
};

/** Who a stage seats: individuals, and each group unit's members by group. */
interface StageSeating {
  /** The stage's approver pool after the access filter: who a veto can belong to. */
  approvers: string[];
  individuals: string[];
  members: Map<string, string[]>;
}

/**
 * Who is seated on a stage, as steward-workflow's assigner does. Approvers and group members who
 * cannot read the policy are dropped; a group unit with a reader left counts as one vote. When
 * the votes left cannot meet the stage quorum, the owners of the policy's home category join as
 * individual seats (applyFilter).
 */
const seatingOf = (
  stage: WorkflowStage,
  pool: string[],
  categoryId: string,
): StageSeating => {
  const reads = (userId: string) => readsCategory(userId, categoryId);
  const seated = pool.filter((id) => reads(id));
  const members = new Map(
    stage.groupUnits.map((g) => [g.groupId, g.memberUserIds.filter(reads)]),
  );
  const votes =
    seated.length + [...members.values()].filter((m) => m.length > 0).length;
  if (meetsQuorum(stage, votes))
    return { approvers: seated, individuals: seated, members };
  const owners =
    data().categories.find((c) => c.id === categoryId)?.owners ?? [];
  return {
    approvers: seated,
    individuals: [...new Set([...seated, ...owners])],
    members,
  };
};

/** A group's required approvals, as steward-workflow's requiredForQuorum. */
const requiredOf = (quorum: string, roster: number): number => {
  if (quorum === "all") return roster;
  if (quorum === "majority") return Math.floor(roster / 2) + 1;
  return 1;
};

const seatFor = (userId: string, groupId?: string) => ({
  comment: null,
  decidedAt: null,
  state: "pending",
  taskId: newId("task"),
  userId,
  ...(groupId ? { groupId } : {}),
});

const groupName = (id: string) =>
  data().platformGroups.find((g) => g.id === id)?.name ?? id;

/** The run's stage: individual seats first, then each group unit with a seated member. */
const runStageOf = (stage: WorkflowStage, seating: StageSeating): RunStage => {
  const membersOf = (groupId: string) => seating.members.get(groupId) ?? [];
  const units = stage.groupUnits.filter((g) => membersOf(g.groupId).length > 0);
  return {
    groups: units.map((g) => {
      const quorum = g.internalQuorum || "one";
      return {
        id: g.groupId,
        name: groupName(g.groupId),
        quorum,
        required: requiredOf(quorum, membersOf(g.groupId).length),
      };
    }),
    name: stage.name,
    quorum: stage.quorum,
    quorumN: stage.quorumN,
    seats: [
      ...seating.individuals.map((userId) => seatFor(userId)),
      ...units.flatMap((g) =>
        membersOf(g.groupId).map((userId) => seatFor(userId, g.groupId)),
      ),
    ],
    slaDays: stage.slaDays,
    vetoUserIds: vetoHolders(stage, seating),
  };
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
    const entered = run.stages[run.currentStageIdx]!;
    entered.dueAt = dueFrom(now(), entered, run.workCalendar);
    return;
  }
  const { policy, version } = partsOf(run);
  run.status = "APPROVAL_STATUS_PUBLISHED";
  publishVersion(policy, version);
  record("policy.status_set", person, versionSubject(policy, version.id));
};

/**
 * The people who hold a veto on a stage: those it names who are in its approver pool once the
 * access filter has run (an individual approver, or a member of a group unit that is seated).
 * Nobody else holds one, whatever their role: not an owner who joined to make up the quorum, not
 * site admin or root, and not a named person the pool does not seat.
 */
const vetoHolders = (stage: WorkflowStage, seating: StageSeating): string[] => {
  const pool = new Set([
    ...seating.approvers,
    ...stage.groupUnits.flatMap((g) => seating.members.get(g.groupId) ?? []),
  ]);
  const holders = [...new Set(stage.vetoUserIds)].filter((id) => pool.has(id));
  const dropped = stage.vetoUserIds.filter((id) => !holders.includes(id));
  if (dropped.length > 0)
    log.debug("veto people not seated, so they hold no veto", {
      count: dropped.length,
      stage: stage.id,
    });
  return holders;
};

const reject = (run: Run) => {
  closePending(run.stages);
  run.status = "APPROVAL_STATUS_REJECTED";
  partsOf(run).version.status = "REJECTED";
};

/**
 * A rejection is a vote against the stage's quorum. The stage is rejected, and with it the run, the
 * version and the other seats, as soon as the approvals still possible (seats that have not voted
 * plus those already given) can no longer reach the number it needs. A group counts the same way
 * against its own required number. While the quorum can still be reached the run goes on and the
 * other seats decide.
 */
const rejectIfQuorum = (run: Run) => {
  const stage = run.stages[run.currentStageIdx];
  if (!stage) return;
  const single = stage.seats.filter((s) => !s.groupId);
  const singlesRejected = single.filter((s) => s.state === "rejected").length;
  const singlesEnd =
    single.length > 0 &&
    single.length - singlesRejected < required({ ...stage, seats: single });
  const groupEnds = (stage.groups ?? []).some(
    (g) => unitOf(stage, g).status === "REJECTED",
  );
  if (singlesEnd || groupEnds) reject(run);
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
        // sending comments back is an approver's act: the seat stays open and no status changes,
        // and what they have been shown so far counts as reviewed
        const { run, seat } = pendingSeatOf(person, given.policyVersionId);
        // the seat's history keeps the comment: the latest request wins, and it outlives the
        // seat's own decision (steward-gateway reads it back as changesRequested)
        seat.changesRequested = { at: now(), comment: given.comment };
        markReviewed(person.id, partsOf(run).version);
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
      markReviewed(person.id, partsOf(run).version);
      seat.state = approve ? "approved" : "rejected";
      seat.comment = given.comment;
      seat.decidedAt = now();
      record(
        approve ? "workflow.decision.approved" : "workflow.decision.rejected",
        person,
        versionSubject(partsOf(run).policy, partsOf(run).version.id),
      );
      if (approve) advance(run, person);
      else if (
        run.stages[run.currentStageIdx]?.vetoUserIds?.includes(person.id)
      )
        reject(run);
      else rejectIfQuorum(run);
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
      // a document with no text can never go for review
      if (!hasContent(version.contentJson))
        throw refuse(
          "FAILED_PRECONDITION",
          "A document with no content can't be submitted.",
        );
      const workflow = workflowOf(policy);
      if (!workflow)
        throw refuse(
          "FAILED_PRECONDITION",
          "No approval workflow is attached to this policy's category.",
        );
      // steward-workflow's Submit: each stage's individual pool comes from the category lineage,
      // and a stage with neither a pool nor group members would never finish
      const lineage = lineageOf(policy.homeCategoryId);
      const pools = workflow.stages.map((s) => poolOf(s, lineage));
      const unstaffed = unstaffedStageOf(workflow, policy);
      if (unstaffed)
        throw refuse(
          "FAILED_PRECONDITION",
          `The "${unstaffed.name}" stage has no approver.`,
        );
      // the size check: an nofm stage cannot ask for more approvals than it has votes, and a
      // group unit with members is one vote
      for (const [index, s] of workflow.stages.entries()) {
        const votes = pools[index]!.length + unitsWithMembers(s);
        if (s.quorum === "nofm" && s.quorumN > votes)
          throw refuse(
            "FAILED_PRECONDITION",
            `stage ${String(index)}: quorum_n=${String(s.quorumN)} exceeds pool size ${String(votes)}`,
          );
      }
      cancelRuns(version.id);
      const run: Run = {
        currentStageIdx: 0,
        id: newId("run"),
        policyId: policy.id,
        policyVersionId: version.id,
        stages: workflow.stages.map((stage, index) =>
          runStageOf(
            stage,
            seatingOf(stage, pools[index]!, policy.homeCategoryId),
          ),
        ),
        status: IN_REVIEW,
        submittedAt: now(),
        submittedBy: person.id,
        workCalendar: structuredClone(data().settings.workCalendar),
        workflowDefId: workflow.id,
      };
      const first = run.stages[0];
      if (first)
        first.dueAt = dueFrom(run.submittedAt, first, run.workCalendar);
      data().runs.push(run);
      version.status = "IN_REVIEW";
      policy.updatedAt = run.submittedAt;
      record("workflow.submitted", person, versionSubject(policy, version.id));
      return { runId: run.id };
    },
  },
  Query: {
    // The caller's own approved or rejected seats on runs still in review (a request for changes
    // leaves the seat pending, so it is not one): one entry per run, the newest decision, and
    // none from before the run started. A policy the caller can no longer read is left out.
    decidedApprovals: (_root, _given, context: Context) => {
      const person = caller(context);
      return openRuns()
        .flatMap((run) => {
          const policy = data().policies.find((p) => p.id === run.policyId);
          if (!policy || readEffect(person, policy) === "deny") return [];
          const newest = run.stages
            .flatMap((stage) => stage.seats)
            .filter(
              (s) =>
                s.userId === person.id &&
                (s.state === "approved" || s.state === "rejected") &&
                s.decidedAt !== null &&
                s.decidedAt >= run.submittedAt,
            )
            .toSorted((a, b) =>
              (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""),
            )[0];
          if (!newest?.decidedAt) return [];
          return [
            {
              currentStageIdx: run.currentStageIdx,
              decidedAt: newest.decidedAt,
              decision: newest.state,
              policyTitle: policy.title,
              policyVersionId: run.policyVersionId,
              runId: run.id,
              stageCount: run.stages.length,
            },
          ];
        })
        .toSorted((a, b) => b.decidedAt.localeCompare(a.decidedAt));
    },
    // steward-gateway's gate runs first (the same one submit uses), then the answer is the
    // workflow's name and whether it can run, never its stages.
    effectiveWorkflow: (
      _root,
      given: { policyId: string },
      context: Context,
    ) => {
      const person = caller(context);
      const policy = found(
        data().policies.find((p) => p.id === given.policyId),
        "policy",
      );
      if (!canEdit(person, policy)) throw forbidden();
      const workflow = workflowOf(policy);
      if (!workflow)
        return {
          firstUnstaffedStage: null,
          hasWorkflow: false,
          name: null,
          usable: true,
          workflowDefId: null,
        };
      const unstaffed = unstaffedStageOf(workflow, policy);
      return {
        firstUnstaffedStage: unstaffed?.name ?? null,
        hasWorkflow: true,
        name: workflow.name || null,
        usable: !unstaffed,
        workflowDefId: workflow.id,
      };
    },
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
      const person = caller(context);
      const run = runFor(given.policyVersionId);
      if (!run) return EMPTY_STATUS;
      // a free-text comment about the content: a reader who sees the policy obfuscated gets none
      const obfuscatedReader =
        readEffect(person, partsOf(run).policy) === "obfuscate";
      return {
        currentStageIdx: run.currentStageIdx,
        runId: run.id,
        stageAssignees: run.stages.map((stage) =>
          stage.seats.map((s) => ({
            changesRequested: obfuscatedReader
              ? null
              : (s.changesRequested?.comment ?? null),
            changesRequestedAt: obfuscatedReader
              ? null
              : (s.changesRequested?.at ?? null),
            comment: s.comment,
            decidedAt: s.decidedAt,
            groupId: s.groupId ?? null,
            name: personOf(s.userId)?.name ?? null,
            state: s.state,
            userId: s.userId,
            veto: stage.vetoUserIds?.includes(s.userId) ?? false,
          })),
        ),
        stageNames: run.stages.map((stage) => stage.name),
        stageProgress: run.stages.map((stage) => ({
          ...individualProgress(stage),
          dueAt: stage.dueAt ?? null,
          quorum: stage.quorum,
          quorumN: stage.quorum === "nofm" ? (stage.quorumN ?? 0) : 0,
        })),
        stageUnitProgress: run.stages.map((stage) =>
          (stage.groups ?? []).map((g) => unitOf(stage, g)),
        ),
        status: run.status,
        submittedAt: run.submittedAt,
        submittedBy: run.submittedBy,
      };
    },
  },
};
