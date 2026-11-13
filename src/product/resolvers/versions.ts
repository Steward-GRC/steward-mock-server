// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The semantic-version fields of policy and template versions, as steward-gateway exposes
// steward-core's (steward-gateway#66): the number, the change type and its history on a policy
// version, and the number and times on a template version. The rules are in semver.ts and the
// state around them in version-numbers.ts.

import type { Template, TemplateVersion } from "#product/data/library.ts";
import type { Policy, PolicyVersion } from "#product/data/policies.ts";

import { type Resolvers } from "#core/graphql.ts";
import { createLogger } from "#core/log.ts";
import { ackTriggersOf } from "#product/access.ts";
import { data } from "#product/resolvers/shared.ts";
import { type ChangeType, semverText } from "#product/semver.ts";
import {
  numbersOf,
  SEEDED_AT,
  settleTemplate,
} from "#product/version-numbers.ts";

const publishedAtOf = (version: TemplateVersion): null | string =>
  version.status === "published" ? (version.publishedAt ?? SEEDED_AT) : null;

/** The latest of a rename and any version of the template made or published. */
const updatedAtOf = (template: Template): string => {
  let latest = template.renamedAt ?? SEEDED_AT;
  for (const version of data().templateVersions) {
    if (version.templateId !== template.id) continue;
    for (const at of [
      version.createdAt ?? SEEDED_AT,
      publishedAtOf(version) ?? SEEDED_AT,
    ])
      if (at > latest) latest = at;
  }
  return latest;
};

const log = createLogger("policy-semver");

/**
 * The number of the policy's current version (steward-gateway#230): the latest published
 * version's. A policy with only a draft, or none, has no released number and answers null.
 */
const currentSemanticVersionOf = (policy: Policy): null | string => {
  const published = data().versions.find(
    (v) => v.id === policy.currentPublishedVersionId,
  );
  if (!published) {
    log.trace("policy has no published version", { policy: policy.id });
    return null;
  }
  const text = numbersOf(published).semanticVersion;
  log.trace("policy current semantic version", {
    policy: policy.id,
    version: published.id,
  });
  return text;
};

/**
 * PolicyVersion.reacknowledge (steward-gateway#232): whether publishing the version asks readers
 * to acknowledge it again. True only for a POLICY whose trigger in force is ON_CHANGE and whose
 * change type is MAJOR. The type is the author's pick (the argument) when given, else the
 * version's own, else its suggestion; none known is false, as is a procedure.
 */
const reacknowledgeOf = (
  version: PolicyVersion,
  pick: ChangeType | null | undefined,
): boolean => {
  const policy = data().policies.find((p) => p.id === version.policyId);
  if (!policy) {
    log.debug("reacknowledge: policy not found", { version: version.id });
    return false;
  }
  if (policy.documentType !== "POLICY") {
    log.debug("reacknowledge: a procedure has no acknowledgements", {
      policy: policy.id,
    });
    return false;
  }
  const trigger = ackTriggersOf(policy);
  if (trigger !== "ON_CHANGE") {
    log.debug("reacknowledge: trigger is not ON_CHANGE", {
      policy: policy.id,
      trigger,
    });
    return false;
  }
  const numbers = numbersOf(version);
  const effective = pick ?? numbers.changeType ?? numbers.suggested;
  log.debug("reacknowledge worked out", {
    effective,
    picked: pick != null,
    policy: policy.id,
    version: version.id,
  });
  return effective === "MAJOR";
};

export const versionResolvers: Resolvers = {
  Policy: {
    currentSemanticVersion: (p) => currentSemanticVersionOf(p as Policy),
  },
  PolicyVersion: {
    changeType: (v) => numbersOf(v as PolicyVersion).changeType,
    changeTypeAgreedByUserIds: (v) => numbersOf(v as PolicyVersion).agreedBy,
    changeTypeReason: (v) => numbersOf(v as PolicyVersion).reason,
    changeTypeSetByUserId: (v) => numbersOf(v as PolicyVersion).setBy,
    reacknowledge: (v, parameters) =>
      reacknowledgeOf(v as PolicyVersion, parameters.changeType),
    requestedChangeType: (v) => numbersOf(v as PolicyVersion).requested,
    semanticVersion: (v) => numbersOf(v as PolicyVersion).semanticVersion,
    suggestedChangeType: (v) => numbersOf(v as PolicyVersion).suggested,
  },
  Template: {
    updatedAt: (t) => updatedAtOf(t as Template),
  },
  TemplateVersion: {
    changeType: (v) => {
      const version = v as TemplateVersion;
      settleTemplate(version.templateId);
      return version.status === "published"
        ? (version.changeType ?? null)
        : null;
    },
    createdAt: (v) => (v as TemplateVersion).createdAt ?? SEEDED_AT,
    publishedAt: (v) => publishedAtOf(v as TemplateVersion),
    semanticVersion: (v) => {
      const version = v as TemplateVersion;
      settleTemplate(version.templateId);
      return version.status === "published" && version.semver
        ? semverText(version.semver)
        : null;
    },
  },
};
