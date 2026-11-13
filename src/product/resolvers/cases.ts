// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The privacy officers' case queue. steward-reporting lets officers in (members of its officer
// groups; a site admin is not one unless they are), so the mock lets in whoever holds the
// privacy-officer role. A closed case takes no more changes.

import type { AuditAction } from "#product/audit-actions.ts";
import type {
  CaseNotice,
  ReportCase,
  RiskAssessment,
  ThreadMessage,
} from "#product/data/cases.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { requireModuleOn } from "#product/resolvers/module.ts";
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

const OFFICER = "privacy-officer";

/** Notice deadlines count from the discovery date: 60 days by default. */
const DAYS_ALLOWED = 60;

const STATUSES = [
  "NEW",
  "IN_REVIEW",
  "NEEDS_REPORTER_REPLY",
  "RISK_ASSESSMENT",
  "NOTIFICATION_DUE",
  "CLOSED",
];

const NOTICE_DEFAULTS: Record<string, { label: string; method: string }> = {
  AFFECTED_PEOPLE: { label: "Affected people", method: "Email" },
  MEDIA: { label: "Media", method: "Press release" },
  OTHER: { label: "Other", method: "Letter" },
  REGULATOR: { label: "Regulator", method: "Letter" },
};

/** Every case call passes the module switch first, ahead of the role check. */
const officer = (context: Context) => {
  requireModuleOn("CaseService");
  const person = caller(context);
  if (!person.roles.includes(OFFICER)) throw forbidden();
  return person;
};

const caseFor = (id: string): ReportCase =>
  found(
    data().reportCases.find((c) => c.id === id),
    "case",
  );

/** An officer and an open case, for every change. */
const openCase = (context: Context, id: string) => {
  const person = officer(context);
  const reportCase = caseFor(id);
  if (reportCase.status === "CLOSED")
    throw refuse("FAILED_PRECONDITION", "This case is closed.");
  return { person, reportCase };
};

const audit = (
  action: AuditAction,
  person: ReturnType<typeof officer>,
  reportCase: ReportCase,
) =>
  record(action, person, {
    id: reportCase.id,
    kind: "case",
    label: reportCase.caseCode,
  });

const addDays = (date: string, days: number) => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

const today = () => now().slice(0, 10);

const nextDeadline = (reportCase: ReportCase) =>
  reportCase.notices
    .filter((n) => n.status !== "SENT" && n.status !== "NOT_NEEDED")
    .map((n) => n.dueOn)
    .toSorted()[0] ?? null;

const summaryOf = (reportCase: ReportCase) => {
  const text = reportCase.details.whatHappened;
  return text.length > 96 ? `${text.slice(0, 95)}…` : text;
};

const officerMessage = (
  body: string,
  officerUserId: string,
): ThreadMessage => ({
  author: "OFFICER",
  body,
  createdAt: now(),
  id: newId("case-message"),
  officerUserId,
});

export const caseResolvers: Resolvers = {
  Mutation: {
    addCaseNote: (
      _root,
      given: { body: string; caseId: string },
      context: Context,
    ) => {
      const { person, reportCase } = openCase(context, given.caseId);
      const note = {
        authorUserId: person.id,
        body: given.body,
        createdAt: now(),
        id: newId("case-note"),
      };
      reportCase.notes.push(note);
      audit("case.note_added", person, reportCase);
      return note;
    },
    addCaseNotice: (
      _root,
      given: {
        caseId: string;
        label?: null | string;
        method?: null | string;
        recipient: string;
      },
      context: Context,
    ) => {
      const { person, reportCase } = openCase(context, given.caseId);
      const defaults = NOTICE_DEFAULTS[given.recipient] ?? {
        label: given.recipient,
        method: "Letter",
      };
      const notice: CaseNotice = {
        daysAllowed: DAYS_ALLOWED,
        dueOn: addDays(reportCase.discoveredOn ?? today(), DAYS_ALLOWED),
        id: newId("case-notice"),
        label: given.label || defaults.label,
        method: given.method || defaults.method,
        recipient: given.recipient,
        sentOn: null,
        status: "NOT_SENT",
      };
      reportCase.notices.push(notice);
      audit("case.notice_added", person, reportCase);
      return notice;
    },
    assignCase: (
      _root,
      given: { assigneeUserId?: null | string; caseId: string },
      context: Context,
    ) => {
      const { person, reportCase } = openCase(context, given.caseId);
      const assignee = given.assigneeUserId
        ? personOf(given.assigneeUserId)
        : null;
      if (given.assigneeUserId && !assignee?.roles.includes(OFFICER))
        throw refuse("BAD_USER_INPUT", "Cases go to privacy officers only.");
      reportCase.assigneeUserId = assignee?.id ?? null;
      audit("case.assigned", person, reportCase);
      return reportCase;
    },
    closeCase: (
      _root,
      given: {
        caseId: string;
        closingMessage?: null | string;
        correctiveActions?:
          | { description: string; policyId?: null | string }[]
          | null;
        outcome: string;
      },
      context: Context,
    ) => {
      const { person, reportCase } = openCase(context, given.caseId);
      if (given.closingMessage)
        reportCase.thread.push(officerMessage(given.closingMessage, person.id));
      reportCase.correctiveActions = (given.correctiveActions ?? []).map(
        (a) => ({
          description: a.description,
          policyId: a.policyId ?? null,
        }),
      );
      reportCase.outcome = given.outcome;
      reportCase.status = "CLOSED";
      reportCase.closedAt = now();
      audit("case.closed", person, reportCase);
      return reportCase;
    },
    postCaseMessage: (
      _root,
      given: { body: string; caseId: string },
      context: Context,
    ) => {
      const { person, reportCase } = openCase(context, given.caseId);
      const message = officerMessage(given.body, person.id);
      reportCase.thread.push(message);
      audit("case.message_posted", person, reportCase);
      return message;
    },
    recordRiskAssessment: (
      _root,
      given: {
        caseId: string;
        decision: string;
        factors: RiskAssessment["factors"];
        reason: string;
      },
      context: Context,
    ) => {
      const { person, reportCase } = openCase(context, given.caseId);
      if (!given.reason.trim())
        throw refuse("BAD_USER_INPUT", "Say why you decided this.");
      const { factors } = given;
      // A rough stand-in for steward-reporting's rules: unknown recipients, a likely view or
      // no mitigation suggests notifying.
      const risky =
        factors.recipient === "UNKNOWN_PEOPLE" ||
        factors.viewed === "YES" ||
        factors.mitigation === "NOT_AT_ALL";
      const assessment: RiskAssessment = {
        decidedAt: now(),
        decidedByUserId: person.id,
        decision: given.decision,
        factors: { ...factors },
        reason: given.reason,
        suggestion: risky
          ? "NOTIFICATION_LIKELY_REQUIRED"
          : "LOW_PROBABILITY_OF_COMPROMISE",
      };
      reportCase.assessment = assessment;
      reportCase.status =
        given.decision === "REPORTABLE" ? "NOTIFICATION_DUE" : "IN_REVIEW";
      audit("case.assessment_recorded", person, reportCase);
      return assessment;
    },
    setCaseDiscoveryDate: (
      _root,
      given: { caseId: string; discoveredOn: string },
      context: Context,
    ) => {
      const { person, reportCase } = openCase(context, given.caseId);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(given.discoveredOn))
        throw refuse("BAD_USER_INPUT", "Give the date as YYYY-MM-DD.");
      reportCase.discoveredOn = given.discoveredOn;
      for (const notice of reportCase.notices)
        notice.dueOn = addDays(given.discoveredOn, notice.daysAllowed);
      audit("case.discovery_date_set", person, reportCase);
      return reportCase;
    },
    setCaseStatus: (
      _root,
      given: { caseId: string; status: string },
      context: Context,
    ) => {
      const { person, reportCase } = openCase(context, given.caseId);
      if (given.status === "CLOSED")
        throw refuse("BAD_USER_INPUT", "Close a case with closeCase.");
      reportCase.status = given.status;
      audit("case.status_changed", person, reportCase);
      return reportCase;
    },
    updateCaseNotice: (
      _root,
      given: {
        caseId: string;
        noticeId: string;
        sentOn?: null | string;
        status: string;
      },
      context: Context,
    ) => {
      const { person, reportCase } = openCase(context, given.caseId);
      const notice = found(
        reportCase.notices.find((n) => n.id === given.noticeId),
        "notice",
      );
      if (given.status === "SENT" && !given.sentOn)
        throw refuse("BAD_USER_INPUT", "Say when the notice was sent.");
      notice.status = given.status;
      notice.sentOn = given.sentOn ?? notice.sentOn;
      audit("case.notice_updated", person, reportCase);
      return notice;
    },
  },
  Query: {
    reportCase: (_root, given: { caseId: string }, context: Context) => {
      officer(context);
      return caseFor(given.caseId);
    },
    reportCases: (
      _root,
      given: { assigneeUserId?: null | string; statuses?: null | string[] },
      context: Context,
    ) => {
      officer(context);
      const all = data().reportCases;
      return {
        cases: all
          .filter((c) => !given.statuses || given.statuses.includes(c.status))
          .filter(
            (c) =>
              !given.assigneeUserId ||
              c.assigneeUserId === given.assigneeUserId,
          )
          .map((c) => ({
            assigneeUserId: c.assigneeUserId,
            caseCode: c.caseCode,
            id: c.id,
            kind: c.kind,
            nextDeadline: nextDeadline(c),
            receivedAt: c.receivedAt,
            status: c.status,
            summary: summaryOf(c),
          })),
        counts: STATUSES.map((status) => ({
          count: all.filter((c) => c.status === status).length,
          status,
        })),
      };
    },
  },
};
