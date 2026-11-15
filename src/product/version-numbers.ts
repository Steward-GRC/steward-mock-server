// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The state around the semantic-version rules (semver.ts): which version a change is compared
// with, what a submit stores, what the first stage's agreement applies, and what a publish
// writes, for policy versions and for template versions. versionNo stays the ordinal; the number
// is MAJOR.MINOR.FIX, written at publish from the highest numbered version before it (steward-core
// #117). A seeded version is numbered on first read: 1.0.0 for a policy's first, then the change
// type its content suggests against the one before.

import type { TemplateVersion } from "#product/data/library.ts";
import type { PolicyVersion } from "#product/data/policies.ts";

import { createLogger } from "#core/log.ts";
import { data, refuse } from "#product/resolvers/shared.ts";
import {
  bump,
  type ChangeState,
  type ChangeType,
  classifyPolicyChange,
  classifyTemplateChange,
  finalizeChange,
  initialState,
  REASON_REQUIRED,
  recordAgreement,
  resolveChange,
  type Revision,
  type Semver,
  semverText,
} from "#product/semver.ts";

const log = createLogger("semver");

/** The time a seeded template version reads as having been made and published. */
export const SEEDED_AT = "2025-01-15T00:00:00.000Z";

/** The policy's numbered versions, oldest first. */
const numbered = (policyId: string): PolicyVersion[] =>
  data()
    .versions.filter((v) => v.policyId === policyId && v.versionNo > 0)
    .toSorted((a, b) => a.versionNo - b.versionNo);

const revisionOf = (version: PolicyVersion): Revision => {
  const pinned = data().templateVersions.find(
    (t) => t.id === version.templateVersionId,
  );
  return {
    contentJson: version.contentJson,
    template: pinned
      ? { sections: pinned.sections, templateId: pinned.templateId }
      : null,
  };
};

/** The highest numbered version of the policy other than this one, which a change is read against. */
const priorOf = (version: PolicyVersion): PolicyVersion | undefined =>
  numbered(version.policyId).findLast((v) => v.id !== version.id);

/** The number a version holds; one stored before semantic versions reads as N.0.0. */
const numberOf = (version: PolicyVersion): Semver =>
  version.semver ?? { fix: 0, major: version.versionNo, minor: 0 };

/** Number the policy's published versions that were seeded without one, oldest first. */
const settle = (policyId: string): void => {
  let previous: PolicyVersion | undefined;
  for (const version of numbered(policyId)) {
    if (!version.semver) {
      if (previous) {
        const fresh = classifyPolicyChange(
          revisionOf(previous),
          revisionOf(version),
        ).type;
        version.change ??= initialState(fresh);
        version.semver = bump(numberOf(previous), version.change.type);
      } else {
        version.semver = bump(null, "FIX");
      }
      log.trace("numbered a seeded version", {
        number: semverText(version.semver),
        version: version.id,
      });
    }
    previous = version;
  }
};

export interface VersionNumbers {
  agreedBy: string[];
  changeType: ChangeType | null;
  reason: null | string;
  requested: ChangeType | null;
  semanticVersion: string;
  setBy: null | string;
  suggested: ChangeType | null;
}

/**
 * What the gateway shows for a version. A published one reads what was stored; any other (a
 * draft, one in review, a rejected or withdrawn one) reads the number a publish would give it
 * from its content as it is now, with the author's pick applied and a lowering still waiting for
 * agreement left out.
 */
export const numbersOf = (version: PolicyVersion): VersionNumbers => {
  settle(version.policyId);
  const change = version.change;
  if (version.versionNo > 0 && version.semver)
    return {
      agreedBy: change?.agreedBy ?? [],
      changeType: change?.type ?? null,
      reason: change?.reason || null,
      requested: change?.requested ?? null,
      semanticVersion: semverText(version.semver),
      setBy: change?.setBy ?? null,
      suggested: change?.suggested ?? null,
    };
  const prior = priorOf(version);
  if (!prior)
    return {
      agreedBy: [],
      changeType: null,
      reason: null,
      requested: null,
      semanticVersion: semverText(bump(null, "FIX")),
      setBy: null,
      suggested: null,
    };
  const fresh = classifyPolicyChange(
    revisionOf(prior),
    revisionOf(version),
  ).type;
  const type = finalizeChange(change ?? null, fresh);
  return {
    agreedBy: change?.agreedBy ?? [],
    changeType: type,
    reason: change?.reason || null,
    requested: change?.requested ?? null,
    semanticVersion: semverText(bump(numberOf(prior), type)),
    setBy: change?.setBy ?? null,
    suggested: fresh,
  };
};

/**
 * What submit stores: the suggestion against the highest numbered version, with the author's
 * pick applied. Throws core's refusal (InvalidArgument) for a pick below the suggestion with no
 * reason, before anything changes. Returns the state to keep, or undefined for a first version,
 * which takes no pick.
 */
export const changeForSubmit = (
  version: PolicyVersion,
  pick: ChangeType | null,
  reason: string,
  actor: string,
): ChangeState | undefined => {
  settle(version.policyId);
  const prior = priorOf(version);
  if (!prior) {
    log.debug("the first version takes no change type", {
      pick: pick ?? "none",
      version: version.id,
    });
    return undefined;
  }
  const suggested = classifyPolicyChange(
    revisionOf(prior),
    revisionOf(version),
  ).type;
  const state = resolveChange(
    version.change ?? null,
    suggested,
    pick,
    reason,
    actor,
  );
  if (!state) {
    log.debug("refused a change type below the suggestion with no reason", {
      pick: pick ?? "none",
      suggested,
      version: version.id,
    });
    // steward-workflow relays core's InvalidArgument with a "submit: " prefix, and the gateway
    // presents it as a business error
    throw refuse("BAD_USER_INPUT", `submit: ${REASON_REQUIRED}`, "business");
  }
  log.debug("change type decided at submit", {
    pick: pick ?? "none",
    requested: state.requested ?? "none",
    suggested,
    type: state.type,
    version: version.id,
  });
  return state;
};

/**
 * The first stage's quorum is met: a lowering the author asked for applies, and the people whose
 * approvals made the quorum are kept as having agreed. Nothing happens without a pending request,
 * so it runs once.
 */
export const agreeLowering = (
  version: PolicyVersion,
  agreedBy: string[],
): boolean => {
  if (!version.change?.requested) return false;
  const next = recordAgreement(version.change, [...new Set(agreedBy)]);
  if (!next) return false;
  log.debug("the first stage agreed to a lowered change type", {
    agreed: next.agreedBy.length,
    type: next.type,
    version: version.id,
  });
  version.change = next;
  return true;
};

/** Write the version's number and final change type at publish. Run before it gets its versionNo. */
export const numberForPublish = (version: PolicyVersion): void => {
  settle(version.policyId);
  const prior = priorOf(version);
  if (!prior) {
    version.semver = bump(null, "FIX");
    delete version.change;
    log.debug("first version published as 1.0.0", { version: version.id });
    return;
  }
  const fresh = classifyPolicyChange(
    revisionOf(prior),
    revisionOf(version),
  ).type;
  const state = version.change ?? initialState(fresh);
  const type = finalizeChange(state, fresh);
  version.change = { ...state, requested: null, suggested: fresh, type };
  version.semver = bump(numberOf(prior), type);
  log.debug("version numbered at publish", {
    fresh,
    number: semverText(version.semver),
    type,
    version: version.id,
  });
};

const publishedTemplateVersions = (
  templateId: string,
  except?: string,
): TemplateVersion[] =>
  data()
    .templateVersions.filter(
      (v) =>
        v.templateId === templateId &&
        v.status === "published" &&
        v.id !== except,
    )
    .toSorted((a, b) => a.versionNo - b.versionNo);

/** Number a published template version seeded without one: 1.0.0 first, then by section change. */
export const settleTemplate = (templateId: string): void => {
  let previous: TemplateVersion | undefined;
  for (const version of publishedTemplateVersions(templateId)) {
    if (!version.semver) {
      if (previous) {
        const type = classifyTemplateChange(
          previous.sections,
          version.sections,
        ).type;
        version.changeType = type;
        version.semver = bump(previous.semver ?? bump(null, "FIX"), type);
      } else {
        version.semver = bump(null, "FIX");
        version.changeType = null;
      }
    }
    previous = version;
  }
};

/** Write a template version's number at publish, against the highest published version before. */
export const numberTemplateForPublish = (version: TemplateVersion): void => {
  settleTemplate(version.templateId);
  const prior = publishedTemplateVersions(version.templateId, version.id).at(
    -1,
  );
  if (prior) {
    const type = classifyTemplateChange(prior.sections, version.sections).type;
    version.changeType = type;
    version.semver = bump(prior.semver ?? bump(null, "FIX"), type);
  } else {
    version.semver = bump(null, "FIX");
    version.changeType = null;
  }
  log.debug("template version numbered at publish", {
    number: semverText(version.semver),
    version: version.id,
  });
};
