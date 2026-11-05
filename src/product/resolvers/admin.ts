// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Site settings and single sign-on: the announcement and maintenance banners, the email
// transport, organisations through their activation gates (domain verified, IdP test passed),
// IdP group mappings and the service-provider certificate. All of it is site admin only, except
// globalSettings, which anyone may read before signing in.

import type { GlobalSettings } from "#product/data.ts";
import type { Organization } from "#product/data/admin.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { spCertificate } from "#product/data/admin.ts";
import {
  data,
  found,
  newId,
  record,
  refuse,
  siteAdmin,
} from "#product/resolvers/shared.ts";

const organizationFor = (domain: string): Organization =>
  found(
    data().organizations.find((o) => o.domain === domain),
    `organization ${domain}`,
  );

const orgSubject = (org: Organization) => ({
  id: org.domain,
  kind: "organization",
  label: org.orgName,
});

const SETTINGS = { id: "global", kind: "settings", label: "Settings" };

export const adminResolvers: Resolvers = {
  Mutation: {
    activateOrganization: (
      _root,
      given: { domain: string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const org = organizationFor(given.domain);
      if (!org.verified || !org.testPassed)
        throw refuse(
          "FAILED_PRECONDITION",
          "Both the domain and the IdP test must pass before activation.",
        );
      org.enabled = true;
      record("organization.activated", admin, orgSubject(org));
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
      const admin = siteAdmin(context);
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
      record("group_mapping.created", admin, {
        id: mapping.id,
        kind: "group_mapping",
        label: given.idpGroupClaimValue,
      });
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
      const admin = siteAdmin(context);
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
      record("organization.created", admin, orgSubject(org));
      return org;
    },
    changeOrgProtocol: (
      _root,
      given: { domain: string; protocol: string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const org = organizationFor(given.domain);
      // A new protocol is a new connection: both activation gates start again.
      Object.assign(org, {
        enabled: false,
        protocol: given.protocol,
        secretReentryRequired: false,
        testPassed: false,
        verified: false,
      });
      record("organization.protocol_changed", admin, orgSubject(org));
      return org;
    },
    deleteGroupMapping: (
      _root,
      given: { mappingId: string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const mapping = found(
        data().groupMappings.find((m) => m.id === given.mappingId),
        "group mapping",
      );
      data().groupMappings = data().groupMappings.filter((m) => m !== mapping);
      record("group_mapping.deleted", admin, {
        id: mapping.id,
        kind: "group_mapping",
        label: mapping.idpGroupClaimValue,
      });
      return true;
    },
    deleteOrganization: (
      _root,
      given: { domain: string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const org = organizationFor(given.domain);
      data().organizations = data().organizations.filter((o) => o !== org);
      data().groupMappings = data().groupMappings.filter(
        (m) => m.connectionId !== org.connectionId,
      );
      record("organization.deleted", admin, orgSubject(org));
      return true;
    },
    disableOrganization: (
      _root,
      given: { domain: string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const org = organizationFor(given.domain);
      org.enabled = false;
      record("organization.disabled", admin, orgSubject(org));
      return org;
    },
    forceRotateSpCertificate: (_root, _given, context: Context) => {
      const admin = siteAdmin(context);
      const serial = Number(data().spCertificate.serial.split("-").at(-1)) + 1;
      data().spCertificate = spCertificate(serial);
      record("sp_certificate.rotated", admin, {
        id: data().spCertificate.serial,
        kind: "sp_certificate",
        label: null,
      });
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
      record("settings.email_updated", admin, SETTINGS);
      return data().emailServiceConfig;
    },
    setGlobalSettings: (
      _root,
      given: { input: GlobalSettings },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const { announcement, maintenance } = given.input;
      if (announcement.enabled && !announcement.message.trim())
        throw refuse(
          "BAD_USER_INPUT",
          "An enabled announcement needs a message.",
        );
      data().settings = { announcement, maintenance };
      record("settings.updated", admin, SETTINGS);
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
      const admin = siteAdmin(context);
      const org = organizationFor(given.domain);
      org.allowLocal = given.allowLocal ?? org.allowLocal;
      org.jitEnabled = given.jitEnabled ?? org.jitEnabled;
      // The mock keeps no secret; a new one only clears the re-entry flag, as identity does.
      if (given.clientSecret || given.secretRef)
        org.secretReentryRequired = false;
      record("organization.updated", admin, orgSubject(org));
      return org;
    },
    verifyDomain: (_root, given: { domain: string }, context: Context) => {
      const admin = siteAdmin(context);
      const org = organizationFor(given.domain);
      org.verified = true;
      record("organization.domain_verified", admin, orgSubject(org));
      return org;
    },
  },
  Query: {
    emailServiceConfig: (_root, _given, context: Context) => {
      siteAdmin(context);
      return data().emailServiceConfig;
    },
    globalSettings: () => data().settings,
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
