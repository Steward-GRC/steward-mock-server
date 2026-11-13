// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Site settings and single sign-on: the announcement and maintenance banners, the email
// transport, organisations through their activation gates (domain verified, IdP test passed),
// IdP group mappings and the service-provider certificate. All of it is site admin only, except
// globalSettings, which anyone may read before signing in. The controls' maintenance window shows
// the gateway's way: announced, it's a warning announcement; on, it's the maintenance notice with
// enabled true. With no window, globalSettings reports what the admin saved.

import type { GlobalSettings } from "#product/data.ts";
import type { Organization } from "#product/data/admin.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { createLogger } from "#core/log.ts";
import {
  maintenance,
  maintenanceControls,
  maintenanceOn,
  type MaintenanceWindow,
} from "#core/maintenance.ts";
import { spCertificate } from "#product/data/admin.ts";
import {
  data,
  found,
  newId,
  record,
  refuse,
  siteAdmin,
} from "#product/resolvers/shared.ts";
import { validateCalendar, WorkcalError } from "#product/workcal.ts";

const organizationFor = (domain: string): Organization =>
  found(
    data().organizations.find((o) => o.domain === domain),
    `organization ${domain}`,
  );

const log = createLogger("steward-settings");

const SETTINGS = { id: "global", kind: "settings", label: "Settings" };

/** The banner's text for a window the controls set without a message. */
const windowMessage = (window: MaintenanceWindow): string => {
  if (window.state === "announced")
    return `Steward maintenance is planned from ${window.startsAt} to ${window.endsAt}.`;
  return window.endsAt
    ? `Steward is down for maintenance until ${window.endsAt}.`
    : "Steward is down for maintenance.";
};

/** The calendar in the setting's shape: refuse it like core, with InvalidArgument and the reason. */
const checkCalendar = (calendar: GlobalSettings["workCalendar"]): void => {
  try {
    validateCalendar({
      holidays: calendar.holidays.map((h) => h.date),
      timezone: calendar.timezone,
      weekdays: calendar.weekdays,
    });
  } catch (error) {
    if (!(error instanceof WorkcalError)) throw error;
    log.debug("work calendar refused", { code: error.code });
    throw refuse("BAD_USER_INPUT", `Work calendar: ${error.message}.`);
  }
  for (const holiday of calendar.holidays) {
    const length = [...holiday.label.trim()].length;
    if (length < 1 || length > 80)
      throw refuse(
        "BAD_USER_INPUT",
        "Work calendar: a holiday label is 1 to 80 characters.",
      );
  }
};

/** The saved settings, with the controls' maintenance window in the banner it belongs in. */
export const globalSettingsNow = (): GlobalSettings => {
  const saved = data().settings;
  const window = maintenance();
  // Maintenance is on only while the window is: saving it on starts the window, and ending the
  // window from the controls turns it off.
  if (window.state === "none")
    return { ...saved, maintenance: { ...saved.maintenance, enabled: false } };
  log.trace("globalSettings reports the maintenance window", {
    state: window.state,
  });
  const message = window.message ?? windowMessage(window);
  if (window.state === "announced")
    return {
      ...saved,
      announcement: { enabled: true, level: "warning", message },
      maintenance: { ...saved.maintenance, enabled: false },
    };
  return { ...saved, maintenance: { enabled: true, message } };
};

// steward-identity audits no organisation, group mapping or SP certificate change (it sends only
// sso.lifecycle notices), so those mutations write no audit entry here either.
export const adminResolvers: Resolvers = {
  Mutation: {
    activateOrganization: (
      _root,
      given: { domain: string },
      context: Context,
    ) => {
      siteAdmin(context);
      const org = organizationFor(given.domain);
      if (!org.verified || !org.testPassed)
        throw refuse(
          "FAILED_PRECONDITION",
          "Both the domain and the IdP test must pass before activation.",
        );
      org.enabled = true;
      return org;
    },
    addGroupMapping: (
      _root,
      given: {
        connectionId: string;
        idpGroupClaimValue: string;
        targetGroupId: string;
      },
      context: Context,
    ) => {
      siteAdmin(context);
      found(
        data().organizations.find((o) => o.connectionId === given.connectionId),
        "connection",
      );
      found(
        data().platformGroups.find((g) => g.id === given.targetGroupId),
        "group",
      );
      const mapping = { ...given, id: newId("group-mapping") };
      data().groupMappings.push(mapping);
      return mapping;
    },
    addOrganization: (
      _root,
      given: {
        input: {
          displayName?: null | string;
          domain: string;
          orgName: string;
          protocol: string;
        };
      },
      context: Context,
    ) => {
      siteAdmin(context);
      const { displayName, domain, orgName, protocol } = given.input;
      if (data().organizations.some((o) => o.domain === domain))
        throw refuse(
          "ALREADY_EXISTS",
          `An organization for ${domain} already exists.`,
        );
      const connectionId = newId("connection");
      const org: Organization = {
        allowLocal: false,
        connectionAlias: `${connectionId}-alias`,
        connectionId,
        displayName: displayName ?? orgName,
        domain,
        enabled: false,
        jitEnabled: true,
        orgName,
        protocol,
        secretReentryRequired: false,
        testPassed: false,
        verified: false,
      };
      data().organizations.push(org);
      return org;
    },
    changeOrgProtocol: (
      _root,
      given: { domain: string; protocol: string },
      context: Context,
    ) => {
      siteAdmin(context);
      const org = organizationFor(given.domain);
      // A new protocol is a new connection: both activation gates start again.
      Object.assign(org, {
        enabled: false,
        protocol: given.protocol,
        secretReentryRequired: false,
        testPassed: false,
        verified: false,
      });
      return org;
    },
    deleteGroupMapping: (
      _root,
      given: { mappingId: string },
      context: Context,
    ) => {
      siteAdmin(context);
      const mapping = found(
        data().groupMappings.find((m) => m.id === given.mappingId),
        "group mapping",
      );
      data().groupMappings = data().groupMappings.filter((m) => m !== mapping);
      return true;
    },
    deleteOrganization: (
      _root,
      given: { domain: string },
      context: Context,
    ) => {
      siteAdmin(context);
      const org = organizationFor(given.domain);
      data().organizations = data().organizations.filter((o) => o !== org);
      data().groupMappings = data().groupMappings.filter(
        (m) => m.connectionId !== org.connectionId,
      );
      return true;
    },
    disableOrganization: (
      _root,
      given: { domain: string },
      context: Context,
    ) => {
      siteAdmin(context);
      const org = organizationFor(given.domain);
      org.enabled = false;
      return org;
    },
    forceRotateSpCertificate: (_root, _given, context: Context) => {
      siteAdmin(context);
      const serial = Number(data().spCertificate.serial.split("-").at(-1)) + 1;
      data().spCertificate = spCertificate(serial);
      return data().spCertificate;
    },
    setEmailServiceConfig: (
      _root,
      given: {
        input: {
          apiKey?: null | string;
          domain: string;
          enabled: boolean;
          fromAddress: string;
          provider: string;
          region: string;
        };
      },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const { apiKey, ...rest } = given.input;
      // The key is write-only: the gateway reports only whether one is stored.
      data().emailServiceConfig = {
        ...rest,
        apiKeySet: apiKey ? true : data().emailServiceConfig.apiKeySet,
      };
      record("email_service_config.updated", admin, SETTINGS);
      return data().emailServiceConfig;
    },
    setGlobalSettings: (
      _root,
      given: {
        input: {
          workCalendar?: GlobalSettings["workCalendar"] | null;
        } & Omit<GlobalSettings, "workCalendar">;
      },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const { announcement, maintenance: notice, workCalendar } = given.input;
      log.debug("setGlobalSettings", {
        actor: admin.id,
        calendarGiven: Boolean(workCalendar),
      });
      if (announcement.enabled && !announcement.message.trim())
        throw refuse(
          "BAD_USER_INPUT",
          "An enabled announcement needs a message.",
        );
      // Absent means unchanged; a given calendar is checked before anything is saved.
      const before = data().settings.workCalendar;
      if (workCalendar) checkCalendar(workCalendar);
      const calendar = workCalendar ?? before;
      const calendarChanged =
        JSON.stringify(calendar) !== JSON.stringify(before);
      data().settings = {
        announcement,
        maintenance: notice,
        workCalendar: calendar,
      };
      record("global_settings.updated", admin, SETTINGS);
      if (calendarChanged) {
        log.info("work calendar changed", {
          actor: admin.id,
          holidays: calendar.holidays.length,
          timezone: calendar.timezone,
          weekdays: calendar.weekdays,
        });
        record("global_settings.work_calendar_updated", admin, SETTINGS);
      }
      // The gateway's maintenance is this setting, so saving it turns the window on or off.
      if (notice.enabled && !maintenanceOn())
        maintenanceControls["maintenance-start"]?.({ message: notice.message });
      if (!notice.enabled && maintenanceOn())
        maintenanceControls["maintenance-end"]?.({});
      return data().settings;
    },
    startDomainVerification: (
      _root,
      given: { domain: string; rotate?: boolean | null },
      context: Context,
    ) => {
      siteAdmin(context);
      const org = organizationFor(given.domain);
      const token = `steward-verify-${org.connectionId}${given.rotate ? `-${newId("rotation")}` : ""}`;
      if (given.rotate) org.verified = false;
      return {
        dnsRecordName: `_steward-verify.${org.domain}`,
        dnsRecordValue: `steward-verify=${token}`,
        instructions: `Add a TXT record named _steward-verify.${org.domain} with the value steward-verify=${token}, then verify.`,
        token,
      };
    },
    updateIdPConnection: (
      _root,
      given: {
        allowLocal?: boolean | null;
        clientSecret?: null | string;
        domain: string;
        jitEnabled?: boolean | null;
        secretRef?: null | string;
      },
      context: Context,
    ) => {
      siteAdmin(context);
      const org = organizationFor(given.domain);
      org.allowLocal = given.allowLocal ?? org.allowLocal;
      org.jitEnabled = given.jitEnabled ?? org.jitEnabled;
      // The mock keeps no secret; a new one only clears the re-entry flag, as identity does.
      if (given.clientSecret || given.secretRef)
        org.secretReentryRequired = false;
      return org;
    },
    verifyDomain: (_root, given: { domain: string }, context: Context) => {
      siteAdmin(context);
      const org = organizationFor(given.domain);
      org.verified = true;
      return org;
    },
  },
  Query: {
    emailServiceConfig: (_root, _given, context: Context) => {
      siteAdmin(context);
      return data().emailServiceConfig;
    },
    globalSettings: () => globalSettingsNow(),
    groupMappings: (
      _root,
      given: { connectionId: string },
      context: Context,
    ) => {
      siteAdmin(context);
      return data().groupMappings.filter(
        (m) => m.connectionId === given.connectionId,
      );
    },
    organizations: (_root, _given, context: Context) => {
      siteAdmin(context);
      return data().organizations;
    },
    spCertificate: (_root, _given, context: Context) => {
      siteAdmin(context);
      return data().spCertificate;
    },
  },
};
