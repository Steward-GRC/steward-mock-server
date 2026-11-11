// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The audit action names Steward's services write, by service, read from each one's audit emit
// calls (the comment above each run names the file in that repo). The mock writes only these, so
// steward-web's history labels match what a real deployment records. A name a service builds at
// run time (workflow.signal.<signal>, workflow.decision.<decision>, workflow.bulk.<decision>,
// user.disabled or user.enabled) is listed once per value it can take.

export const AUDIT_ACTIONS = {
  core: [
    // steward-core/internal/grpcsvc/asset_handler.go
    "asset.uploaded",
    // steward-core/internal/grpcsvc/breakglass_read.go
    "policy.break_glass_read",
    // steward-core/internal/grpcsvc/callers.go
    "rpc.denied",
    // steward-core/internal/grpcsvc/category_handler.go
    "category.created",
    "category.defaults_set",
    "category.document_types_set",
    "category.deleted",
    "category.governance_updated",
    "category.moved",
    "category.reordered",
    "category.renamed",
    "category_rule.created",
    "category_rule.deleted",
    "category_rule.updated",
    // steward-core/internal/grpcsvc/category_rule_purge.go
    "category.ruleset_changed",
    // steward-core/internal/grpcsvc/definition_library_handler.go
    "definition.archived",
    "definition.created",
    "definition.deleted",
    "definition.updated",
    "policy.definitions_changed",
    // steward-core/internal/grpcsvc/policy_handler.go
    "policy.ack_config_updated",
    "policy.created",
    "policy.deleted",
    "policy.draft_content_updated",
    "policy.draft_discarded",
    "policy.draft_saved",
    "policy.bulk_moved",
    "policy.moved",
    "policy.owner_changed",
    "policy.published",
    "policy.reindexed",
    "policy.rename_staged",
    "policy.renamed",
    "policy.retired",
    "policy.sensitivity_changed",
    "policy.status_set",
    "policy.template_changed",
    // steward-core/internal/grpcsvc/reference_handler.go
    "policy.references_changed",
    "reference.archived",
    "reference.created",
    "reference.deleted",
    "reference.updated",
    // steward-core/internal/grpcsvc/settings_handler.go
    "email_service_config.updated",
    "global_settings.updated",
    // steward-core/internal/grpcsvc/template_handler.go
    "template.created",
    "template.deleted",
    "template.renamed",
    "template.retired",
    "template_version.created",
    "template_version.discarded",
    "template_version.published",
    "template_version.updated",
  ],
  delivery: [
    // steward-delivery/internal/magiclink/service.go
    "magic_link.created",
    "magic_link.revoked",
  ],
  gateway: [
    // steward-gateway/internal/resolvers/impersonation_resolver.go
    "impersonation.started",
    "impersonation.stopped",
  ],
  identity: [
    // steward-identity/internal/handlers/admin.go
    "session.revoked",
    // steward-identity/internal/handlers/admin_delete.go
    "user.category_rules_purged",
    "user.credential_revoked",
    // steward-identity/internal/handlers/admin_sso.go
    "security.break_glass.login",
    // steward-identity/internal/server/callers.go
    "rpc.denied",
    // steward-identity/internal/store/breakglass.go
    "policy.break_glass_revealed",
    // steward-identity/internal/store/group_managers.go
    "group.manager_granted",
    "group.manager_revoked",
    // steward-identity/internal/store/groups.go
    "group.created",
    "group.deleted",
    "group.renamed",
    "group.reparented",
    // steward-identity/internal/store/hard_reset.go
    "hard_reset.approved",
    "hard_reset.cancelled",
    "hard_reset.consumed",
    "hard_reset.expired",
    "hard_reset.requested",
    // steward-identity/internal/store/membership.go
    "group.member_added",
    "group.member_removed",
    // steward-identity/internal/store/membership_ext.go
    "user.policy_override_cleared",
    "user.policy_override_set",
    // steward-identity/internal/store/merge.go
    "user.accounts_merged",
    // steward-identity/internal/store/mfa.go
    "user.mfa_factor_enrolled",
    "user.mfa_factor_relabeled",
    "user.mfa_factor_removed",
    // steward-identity/internal/store/mfa_admin.go
    "admin.mfa_factor_relabeled",
    "admin.mfa_factor_removed",
    // steward-identity/internal/store/permissions.go
    "permission.granted",
    "permission.revoked",
    // steward-identity/internal/store/roles.go
    "role.granted",
    "role.revoked",
    "root.granted",
    "root.revoked",
    "user.created",
    // steward-identity/internal/store/users.go
    "user.adopted",
    "user.bootstrap_root",
    "user.deleted",
    "user.disabled",
    "user.email.verified",
    "user.enabled",
    "user.login.success",
    "user.onboarding.completed",
    "user.profile.updated",
    "user.username.updated",
  ],
  obligations: [
    // steward-obligations/internal/ack/platform_audit.go
    "ack.recorded",
    "ack.transferred",
    // steward-obligations/internal/consumer/platform_audit.go
    "policy.ack_required",
    // steward-obligations/internal/grpcsvc/callers.go
    "rpc.denied",
    // steward-obligations/internal/mail/recorder.go
    "email.failed",
    "email.sent",
  ],
  reporting: [
    // steward-reporting/cmd/server/main.go
    "reporting.call.refused",
    // steward-reporting/internal/grpcsvc/cases.go
    "case.access_refused",
    "case.assessment_recorded",
    "case.assigned",
    "case.attachment_viewed",
    "case.closed",
    "case.discovery_date_set",
    "case.listed",
    "case.message_posted",
    "case.note_added",
    "case.notice_added",
    "case.notice_updated",
    "case.status_changed",
    "case.viewed",
    // steward-reporting/internal/grpcsvc/holds.go
    "legal_hold.access_refused",
    "legal_hold.listed",
    "legal_hold.placed",
    "legal_hold.released",
    // steward-reporting/internal/grpcsvc/intake.go
    "report.check_refused",
    "report.checked",
    "report.listed",
    "report.replied",
    "report.submitted",
    "report.viewed",
    // steward-reporting/internal/grpcsvc/settings.go
    "settings.access_refused",
    "settings.read",
    "settings.updated",
    // steward-reporting/internal/retention/retention.go
    "case.purged",
  ],
  workflow: [
    // steward-workflow/internal/grpcsvc/callers.go
    "rpc.denied",
    // steward-workflow/internal/grpcsvc/workflow.go
    "workflow.assignment.swapped",
    "workflow.assignment.swapped.out_of_eligibility",
    "workflow.bulk.approved",
    "workflow.bulk.rejected",
    "workflow.decision.approved",
    "workflow.decision.rejected",
    "workflow.gc.failed",
    "workflow.gc.skip.get_def_failed",
    "workflow.gc.skip.list_active_failed",
    "workflow.gc.version",
    "workflow.signal.approve",
    "workflow.signal.reject",
    "workflow.signal.request_changes",
    "workflow.signal.retire",
    "workflow.signal.withdraw",
    "workflow.stage.misconfigured",
    "workflow.stage.unstaffed",
    "workflow.submit.no_workflow",
    "workflow.submitted",
    "workflow.user.reassigned",
    "workflow.withdrawn",
    // steward-workflow/internal/grpcsvc/workflow_def.go
    "workflow_def.archived",
    "workflow_def.created",
    "workflow_def.updated",
    // steward-workflow/internal/outage/reconciler.go
    "workflow.run.paused",
    "workflow.run.resumed",
    // steward-workflow/internal/worker/policy_worker.go
    "workflow.stage.escalated",
  ],
} as const;

/** An action one of the services writes. */
export type AuditAction =
  (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS][number];

/** Every action any service writes. */
export const auditActions: ReadonlySet<string> = new Set(
  Object.values(AUDIT_ACTIONS).flat(),
);
