// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The Compliance module switch and the four-eyes hard reset, as steward-reporting
// (ModuleService, SettingsService) and steward-identity (the hard reset requests) keep them.
//
// The switch: off refuses every case call with MODULE_OFF (8113) and keeps the data; the settings
// and the switch stay open so an admin can turn it back on. Compliance admins and root read and
// change it, never while acting as someone else.
//
// The hard reset: the root admin asks (requestHardReset); a DIFFERENT active site admin approves
// (root counts as a site admin, but cannot approve its own request); only the requester cancels;
// root or any site admin lists. executeHardReset is root only: the exact phrase, the module off, no
// case under a legal hold, then it redeems the approved request once and deletes every case. The
// switch stays off. One audit event, module.hard_reset, names the request, both admins and the
// count; it never carries a case or a reporter.

import { GraphQLError } from "graphql";

import type { StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { createLogger } from "#core/log.ts";
import { impersonationOf } from "#product/impersonation.ts";
import {
  data,
  newId,
  now,
  personOf,
  realCaller,
  record,
  refuse,
  reportingRefusal,
} from "#product/resolvers/shared.ts";
import { isRoot } from "#product/resolvers/users.ts";

const log = createLogger("steward-module");

/** The phrase an admin types, exactly, to run a hard reset (reporting's HardResetPhrase). */
export const HARD_RESET_PHRASE = "RESET COMPLIANCE DATA";

const MODULE = "compliance";
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const APPROVAL_WINDOW_MS = 60 * 60 * 1000;

/** One identity hard reset request (HardResetRequest in the schema, plus nothing the API hides). */
export interface HardResetRow {
  approvalExpiresAt: null | string;
  approvedAt: null | string;
  approvedBy: null | string;
  cancelledAt: null | string;
  consumedAt: null | string;
  consumedBy: string;
  expiresAt: string;
  id: string;
  module: string;
  reason: string;
  requestedAt: string;
  requestedBy: string;
  state: "approved" | "cancelled" | "consumed" | "expired" | "pending";
}

const moduleSubject = {
  id: MODULE,
  kind: "module",
  label: "Compliance",
};

/** MODULE_OFF while the module is off: the gate every intake and case call passes first. */
export const requireModuleOn = (method: string): void => {
  if (data().complianceModuleEnabled) return;
  log.debug("call refused: the compliance module is off", { method });
  throw reportingRefusal(
    "MODULE_OFF",
    8113,
    "Compliance reporting is switched off.",
  );
};

const actAsRefused = (): GraphQLError =>
  reportingRefusal(
    "ACT_AS_NOT_ALLOWED",
    8110,
    "Cases and reports can't be opened while acting as another user.",
  );

/** The signed-in person themselves; refused while they act as someone else. */
const signedInUser = (context: Context): StewardPerson => {
  const person = realCaller(context);
  if (impersonationOf(context)) {
    log.debug("refused while acting as another user", { personId: person.id });
    record("module.access_refused", person, moduleSubject);
    throw actAsRefused();
  }
  return person;
};

/** Compliance admins (compliance.manage) and root; a plain site admin is neither. */
const settingsAdmin = (
  context: Context,
  refusedAction: "module.access_refused" | "settings.access_refused",
): StewardPerson => {
  const person = signedInUser(context);
  if (isRoot(person) || person.roles.includes("compliance-admin"))
    return person;
  log.debug("settings admin call refused", {
    action: refusedAction,
    personId: person.id,
  });
  record(refusedAction, person, moduleSubject);
  throw reportingRefusal(
    "SETTINGS_ACCESS_DENIED",
    8111,
    "Only compliance admins can see or change the Compliance settings.",
  );
};

/** An enabled, live account holding the site-admin role (root holds it too). */
const activeSiteAdmin = (person: StewardPerson): boolean =>
  !person.disabled && !person.deletedAt && person.roles.includes("site-admin");

const activeRoot = (person: StewardPerson | undefined): boolean =>
  !!person && !person.disabled && !person.deletedAt && isRoot(person);

/** identity's refusal of a hard reset step during act-as, as the gateway relays it. */
const actAsForbidden = (): GraphQLError =>
  new GraphQLError(
    "This action isn't available while you're acting as another user. Stop acting as them first.",
    { extensions: { code: "ACT_AS_FORBIDDEN" } },
  );

/** The caller of a request, approve, cancel or list step: a site admin, never during act-as. */
const hardResetActor = (context: Context): StewardPerson => {
  const person = realCaller(context);
  if (impersonationOf(context)) throw actAsForbidden();
  if (!activeSiteAdmin(person) && !isRoot(person))
    throw refuse(
      "FORBIDDEN",
      "a hard reset needs the approval of a different, active site-admin",
    );
  return person;
};

/** Marks every open request past its deadline expired, as identity does first in every step. */
const expireStale = (): void => {
  const at = Date.now();
  for (const row of data().hardResets) {
    const lapsed =
      (row.state === "pending" && Date.parse(row.expiresAt) <= at) ||
      (row.state === "approved" &&
        Date.parse(row.approvalExpiresAt ?? row.expiresAt) <= at);
    if (lapsed) {
      log.debug("hard reset request expired", { requestId: row.id });
      row.state = "expired";
    }
  }
};

const requestFor = (id: string): HardResetRow => {
  const row = data().hardResets.find((r) => r.id === id);
  if (!row) throw refuse("NOT_FOUND", "hard reset request not found");
  return row;
};

const isOpen = (row: HardResetRow) =>
  row.state === "pending" || row.state === "approved";

const requestSubject = (row: HardResetRow) => ({
  id: row.id,
  kind: "hard_reset",
  label: row.module,
});

/** Records a refused hard reset (the reason only, never content) and returns the refusal. */
const resetRefused = (
  person: StewardPerson,
  reason: string,
  cause: GraphQLError,
): GraphQLError => {
  log.warn("hard reset refused", { personId: person.id, reason });
  record("module.hard_reset_refused", person, {
    ...moduleSubject,
    label: reason,
  });
  return cause;
};

export const moduleResolvers: Resolvers = {
  Mutation: {
    approveHardReset: (
      _root,
      given: { requestId: string },
      context: Context,
    ) => {
      const approver = hardResetActor(context);
      expireStale();
      const row = requestFor(given.requestId);
      if (row.requestedBy === approver.id)
        throw refuse(
          "FORBIDDEN",
          "a different site-admin must approve: the requester can't",
        );
      if (!activeSiteAdmin(approver))
        throw refuse(
          "FORBIDDEN",
          "a hard reset needs the approval of a different, active site-admin",
        );
      if (row.state !== "pending")
        throw refuse("FAILED_PRECONDITION", `it is ${row.state}`);
      if (!activeRoot(personOf(row.requestedBy)))
        throw refuse(
          "FAILED_PRECONDITION",
          "it is pending: the requester is no longer the root admin",
        );
      const at = now();
      row.state = "approved";
      row.approvedBy = approver.id;
      row.approvedAt = at;
      row.approvalExpiresAt = new Date(
        Date.parse(at) + APPROVAL_WINDOW_MS,
      ).toISOString();
      record("hard_reset.approved", approver, requestSubject(row));
      log.info("hard reset approved", {
        approvedBy: approver.id,
        requestId: row.id,
      });
      return row;
    },
    cancelHardReset: (
      _root,
      given: { requestId: string },
      context: Context,
    ) => {
      const actor = hardResetActor(context);
      expireStale();
      const row = requestFor(given.requestId);
      if (row.requestedBy !== actor.id)
        throw refuse(
          "FORBIDDEN",
          "only the requester can cancel a hard reset request",
        );
      if (!isOpen(row))
        throw refuse("FAILED_PRECONDITION", `it is ${row.state}`);
      row.state = "cancelled";
      row.cancelledAt = now();
      record("hard_reset.cancelled", actor, requestSubject(row));
      log.info("hard reset cancelled", { requestId: row.id });
      return row;
    },
    executeHardReset: (
      _root,
      given: { confirmation: string; requestId: string },
      context: Context,
    ) => {
      const person = signedInUser(context);
      log.info("hard reset asked for", {
        personId: person.id,
        requestId: given.requestId,
      });
      if (!isRoot(person))
        throw resetRefused(
          person,
          "not_root",
          reportingRefusal(
            "HARD_RESET_ROOT_REQUIRED",
            8118,
            "Only the root admin can run a hard reset.",
          ),
        );
      if (given.confirmation !== HARD_RESET_PHRASE)
        throw resetRefused(
          person,
          "confirmation",
          reportingRefusal(
            "HARD_RESET_CONFIRMATION",
            8114,
            "The confirmation phrase doesn't match. Type it exactly as shown.",
          ),
        );
      if (data().complianceModuleEnabled)
        throw resetRefused(
          person,
          "module_on",
          reportingRefusal(
            "HARD_RESET_MODULE_ON",
            8115,
            "Switch the module off first.",
          ),
        );
      if (data().reportCases.some((c) => c.legalHold))
        throw resetRefused(
          person,
          "legal_hold",
          reportingRefusal(
            "HARD_RESET_LEGAL_HOLD",
            8116,
            "A case is under a legal hold.",
          ),
        );

      // Every check that can fail has run; now the approval is redeemed, once.
      expireStale();
      const notApproved = (reason: string) =>
        resetRefused(
          person,
          reason,
          reportingRefusal(
            "HARD_RESET_NOT_APPROVED",
            8117,
            "This hard reset has no valid approval from a second admin.",
          ),
        );
      const row = data().hardResets.find((r) => r.id === given.requestId);
      if (!row || row.module !== MODULE || row.state !== "approved")
        throw notApproved("not_approved");
      const requester = personOf(row.requestedBy);
      const approver = personOf(row.approvedBy);
      if (
        !activeRoot(requester) ||
        !approver ||
        !activeSiteAdmin(approver) ||
        row.requestedBy === row.approvedBy
      )
        throw notApproved("not_two_admins");
      row.state = "consumed";
      row.consumedAt = now();
      row.consumedBy = "reporting";
      record("hard_reset.consumed", person, requestSubject(row));

      const casesDeleted = data().reportCases.length;
      data().reportCases = [];
      record("module.hard_reset", person, {
        id: MODULE,
        kind: "module",
        label: `request ${row.id}; requested by ${row.requestedBy}; approved by ${row.approvedBy ?? ""}; ${String(casesDeleted)} cases deleted`,
      });
      log.info("compliance module hard reset", {
        approvedBy: row.approvedBy,
        casesDeleted,
        requestedBy: row.requestedBy,
        requestId: row.id,
      });
      return {
        approvedBy: row.approvedBy,
        casesDeleted,
        requestedBy: row.requestedBy,
      };
    },
    requestHardReset: (
      _root,
      given: { module: string; reason: string },
      context: Context,
    ) => {
      const requester = hardResetActor(context);
      expireStale();
      if (!isRoot(requester))
        throw refuse(
          "FORBIDDEN",
          "only the root admin can request a hard reset",
        );
      const module = given.module.trim().toLowerCase();
      if (module !== MODULE)
        throw refuse(
          "BAD_USER_INPUT",
          "module must be one that can be hard reset: compliance",
        );
      const reason = given.reason.trim();
      if (!reason) throw refuse("BAD_USER_INPUT", "reason required");
      if (data().hardResets.some((r) => r.module === module && isOpen(r)))
        throw refuse(
          "FAILED_PRECONDITION",
          `module "${module}" already has an open hard reset request`,
        );
      const at = now();
      const row: HardResetRow = {
        approvalExpiresAt: null,
        approvedAt: null,
        approvedBy: null,
        cancelledAt: null,
        consumedAt: null,
        consumedBy: "",
        expiresAt: new Date(Date.parse(at) + REQUEST_WINDOW_MS).toISOString(),
        id: newId("hard-reset"),
        module,
        reason,
        requestedAt: at,
        requestedBy: requester.id,
        state: "pending",
      };
      data().hardResets.push(row);
      record("hard_reset.requested", requester, requestSubject(row));
      log.info("hard reset requested", {
        module,
        requestedBy: requester.id,
        requestId: row.id,
      });
      return row;
    },
    setComplianceModule: (
      _root,
      given: { enabled: boolean },
      context: Context,
    ) => {
      const person = settingsAdmin(context, "module.access_refused");
      data().complianceModuleEnabled = given.enabled;
      record(
        given.enabled ? "module.enabled" : "module.disabled",
        person,
        moduleSubject,
      );
      log.info("compliance module switched", {
        enabled: given.enabled,
        personId: person.id,
      });
      return { moduleEnabled: given.enabled };
    },
  },
  Query: {
    complianceSettings: (_root, _given, context: Context) => {
      const person = settingsAdmin(context, "settings.access_refused");
      record("settings.read", person, moduleSubject);
      return { moduleEnabled: data().complianceModuleEnabled };
    },
    hardResetRequests: (
      _root,
      given: { module?: null | string },
      context: Context,
    ) => {
      hardResetActor(context);
      expireStale();
      const wanted = given.module?.trim().toLowerCase();
      return data()
        .hardResets.filter((r) => !wanted || r.module === wanted)
        .toReversed();
    },
  },
};
