// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The contract with steward-web: every operation its api-client sends (copied into
// web-operations/ at the commit its README names) runs here over HTTP, as someone whose role may
// call it, with variables from the seed. A validation error means the schema copy and the web
// disagree; a null in a non-null field means a resolver doesn't answer what the web selects.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { RunningMockServer } from "#core/server.ts";

import { auditActions } from "#product/audit-actions.ts";
import { stewardData } from "#product/data.ts";
import { EXPENSE_CLAIMS_NUMBER } from "#product/data/policies.ts";
import {
  control,
  openSocket,
  query,
  type Signed,
  startForTests,
} from "#product/test-client.ts";
import { documentOf, signInAs, webOperations } from "#product/web-client.ts";

interface Case {
  /** The field answers null as the gateway's normal answer (no AI summary stored, say). */
  answersNull?: boolean;
  /** The person who calls it: someone whose role the gateway lets through. */
  as: string;
  /** The code the gateway answers with instead of data, when that's its normal answer. */
  refused?: string;
  variables?: Record<string, unknown>;
}

const ADMIN = "user-alice";
const AUTHOR = "user-bob";
const APPROVER = "user-charlie";
const OFFICER = "user-dave";
const READER = "user-erin";
/** The AI service isn't part of the mock: the gateway answers its calls as when it's down. */
const AI_DOWN = "INTERNAL";

const SECTION = { blocks: [], key: "purpose", order: 0, title: "Purpose" };

const cases: Record<string, Case> = {
  AckRoster: { as: ADMIN, variables: { policyVersionId: "version-2" } },
  AckStatus: { as: READER, variables: { policyVersionId: "version-2" } },
  ActivateOrganization: {
    as: ADMIN,
    variables: { domain: "branch.example.net" },
  },
  AddAppendix: {
    as: AUTHOR,
    variables: {
      contentJson: JSON.stringify({ text: "Who signs off on exceptions." }),
      policyVersionId: "version-3",
      title: "Exceptions",
    },
  },
  AddCaseNote: {
    as: OFFICER,
    variables: { body: "Spoke to the team lead.", caseId: "case-2" },
  },
  AddCaseNotice: {
    as: OFFICER,
    variables: { caseId: "case-3", recipient: "MEDIA" },
  },
  AddGroupMapping: {
    as: ADMIN,
    variables: {
      connectionId: "connection-1",
      idpGroupClaimValue: "facilities",
      targetGroupId: "group-3",
    },
  },
  AddOrganization: {
    as: ADMIN,
    variables: {
      input: {
        domain: "lab.example.net",
        orgName: "Lab Example",
        protocol: "oidc",
      },
    },
  },
  AddUserToGroup: {
    as: ADMIN,
    variables: { groupId: "group-2", userId: READER },
  },
  // AI isn't mocked: the settings answer as the gateway does with the ai service down.
  AiConfig: { as: ADMIN, refused: AI_DOWN },
  AiHealth: { as: READER },
  AiJob: { as: AUTHOR, refused: AI_DOWN, variables: { jobId: "ai-job-1" } },
  AiJobResultContent: {
    as: AUTHOR,
    refused: AI_DOWN,
    variables: { resultRef: "ai-job-1" },
  },
  ArchiveWorkflowDef: { as: ADMIN, variables: { id: "workflow-3" } },
  AssignCase: {
    as: OFFICER,
    variables: { assigneeUserId: OFFICER, caseId: "case-1" },
  },
  AuditLog: { as: ADMIN, variables: { pageSize: 20 } },
  AuthoringAssist: {
    as: AUTHOR,
    refused: AI_DOWN,
    variables: {
      input: {
        editableContent: "Systems are for work use.",
        operation: "ASSIST_OPERATION_EXPAND",
        policyId: "policy-2",
        sectionKey: "purpose",
        versionId: "version-3",
      },
    },
  },
  BreakGlassReveal: {
    as: ADMIN,
    variables: { policyId: "policy-8", reason: "Incident review" },
  },
  Category: { as: ADMIN, variables: { id: "category-finance" } },
  CategoryChildren: {
    as: READER,
    variables: { parentId: "category-information" },
  },
  CategoryRuleset: {
    as: ADMIN,
    variables: { categoryId: "category-facilities" },
  },
  CategoryTree: { as: READER },
  ChangeOrgProtocol: {
    as: ADMIN,
    variables: {
      clientSecret: "invented-client-secret",
      config: [{ key: "issuer", value: "https://idp.partner.example.net" }],
      domain: "partner.example.net",
      protocol: "oidc",
    },
  },
  CloseCase: {
    as: OFFICER,
    variables: {
      caseId: "case-2",
      closingMessage: "Thank you for telling us.",
      correctiveActions: [{ description: "Recalled the email." }],
      outcome: "SUBSTANTIATED",
    },
  },
  CompleteOnboarding: { as: READER, variables: { acceptTerms: true } },
  CompletionReport: { as: ADMIN, variables: { policyVersionId: "version-2" } },
  ContactBlocks: { as: AUTHOR, variables: { includeArchived: true } },
  CreateCategory: {
    as: ADMIN,
    variables: { name: "Legal", parentId: null, slug: "legal" },
  },
  CreateContactBlock: {
    as: ADMIN,
    variables: { block: { email: "privacy@example.org", label: "Privacy" } },
  },
  CreateDefinition: {
    as: ADMIN,
    variables: {
      input: {
        categoryId: "category-finance",
        definition: "A fixed daily allowance for travel.",
        term: "Per diem",
      },
    },
  },
  CreatePlatformGroup: {
    as: ADMIN,
    variables: { name: "Contractors", parentId: "group-1" },
  },
  CreatePolicy: {
    as: AUTHOR,
    variables: {
      documentType: "POLICY",
      homeCategoryId: "category-expenses",
      sensitivity: "STANDARD",
      templateId: "template-1",
      title: "Travel Booking",
    },
  },
  CreateReference: {
    as: ADMIN,
    variables: {
      input: {
        body: "Keep records seven years.",
        kind: "TEXT",
        label: "Records",
      },
    },
  },
  CreateTemplate: {
    as: ADMIN,
    variables: { name: "Short policy", ownerCategoryId: "category-people" },
  },
  CreateTemplateVersion: {
    as: ADMIN,
    variables: { sections: [SECTION], templateId: "template-2" },
  },
  CreateWorkflowDef: {
    as: ADMIN,
    variables: {
      name: "Two step",
      stages: [{ approvers: [APPROVER], name: "Review", quorum: "one" }],
    },
  },
  Definitions: {
    as: AUTHOR,
    variables: { categoryId: "category-information", includeArchived: true },
  },
  DeleteAppendix: { as: AUTHOR, variables: { id: "appendix-2" } },
  DeleteCategory: { as: ADMIN, variables: { id: "category-phones" } },
  DeleteDefinition: { as: ADMIN, variables: { id: "definition-2" } },
  DeleteGroupMapping: {
    as: ADMIN,
    variables: { mappingId: "group-mapping-1" },
  },
  DeleteOrganization: {
    as: ADMIN,
    variables: { domain: "partner.example.net" },
  },
  DeleteReference: { as: ADMIN, variables: { id: "reference-2" } },
  DeleteTemplate: { as: ADMIN, variables: { id: "template-3" } },
  DeleteUser: { as: ADMIN, variables: { userId: "user-frank" } },
  Diagnostics: { as: ADMIN },
  DiffVersions: {
    as: READER,
    variables: { fromVersionId: "version-1", toVersionId: "version-2" },
  },
  DisableOrganization: {
    as: ADMIN,
    variables: { domain: "partner.example.net" },
  },
  DisableUser: { as: ADMIN, variables: { userId: READER } },
  DiscardDraft: { as: AUTHOR, variables: { policyId: "policy-2" } },
  DiscardTemplateVersion: {
    as: ADMIN,
    variables: { id: "template-version-3" },
  },
  EmailServiceConfig: { as: ADMIN },
  EnableUser: { as: ADMIN, variables: { userId: "user-frank" } },
  ExportAcks: {
    as: ADMIN,
    variables: { format: "csv", policyVersionId: "version-2" },
  },
  ForceRotateSpCertificate: { as: ADMIN },
  GlobalSettings: { as: READER },
  GrantRole: { as: ADMIN, variables: { role: "author", userId: READER } },
  // Without a step-up code asked for first, identity refuses it; the one-step case can't ask.
  GrantRoot: {
    as: ADMIN,
    refused: "InvalidArgument",
    variables: { otp: "123456", userId: AUTHOR },
  },
  GroupMappings: { as: ADMIN, variables: { connectionId: "connection-1" } },
  ImpersonationStatus: { answersNull: true, as: ADMIN },
  IssueCollabToken: {
    as: AUTHOR,
    variables: { draftId: "version-3", policyId: "policy-2" },
  },
  LatestTemplateVersion: {
    as: AUTHOR,
    variables: { templateId: "template-1" },
  },
  ListUserSessions: { as: ADMIN, variables: { userId: AUTHOR } },
  ManagedGroupMembers: { as: APPROVER, variables: { groupId: "group-2" } },
  Me: { as: READER },
  MergeAccounts: {
    as: ADMIN,
    variables: {
      confirmPrivileged: false,
      idempotencyKey: "merge-frank",
      sourceUserId: "user-frank",
      targetUserId: READER,
    },
  },
  MoveCategory: {
    as: ADMIN,
    variables: {
      categoryId: "category-phones",
      newParentId: "category-information",
    },
  },
  MyAckSummary: { as: READER },
  MyDrafts: { as: AUTHOR },
  MyFactors: { as: READER },
  MyManagedGroups: { as: APPROVER },
  MyObligations: { as: READER },
  Organizations: { as: ADMIN },
  PendingTasks: { as: APPROVER },
  PlatformGroups: { as: ADMIN, variables: { parentId: null } },
  Policies: {
    as: READER,
    variables: { categoryId: "category-finance", documentType: "POLICY" },
  },
  Policy: { as: AUTHOR, variables: { id: "policy-2" } },
  PolicyAttachments: { as: READER, variables: { policyId: "policy-1" } },
  PolicyByNumber: { as: READER, variables: { number: EXPENSE_CLAIMS_NUMBER } },
  PolicyVersion: { as: READER, variables: { id: "version-2" } },
  PolicyVersions: { as: READER, variables: { policyId: "policy-1" } },
  PolicyVersionSummary: {
    answersNull: true,
    as: READER,
    variables: { versionId: "version-2" },
  },
  PostCaseMessage: {
    as: OFFICER,
    variables: { body: "Could you tell us more?", caseId: "case-1" },
  },
  PreviewAccountMerge: {
    as: ADMIN,
    variables: { sourceUserId: "user-frank", targetUserId: READER },
  },
  PreviewUserDeletion: { as: ADMIN, variables: { userId: APPROVER } },
  PublishDraft: { as: AUTHOR, variables: { policyId: "policy-2" } },
  PublishTemplateVersion: {
    as: ADMIN,
    variables: { id: "template-version-3" },
  },
  ReassignUserPolicies: {
    as: ADMIN,
    variables: { fromUserId: AUTHOR, toUserId: APPROVER },
  },
  RecordAck: { as: READER, variables: { policyVersionId: "version-2" } },
  RecordRiskAssessment: {
    as: OFFICER,
    variables: {
      caseId: "case-2",
      decision: "NOT_REPORTABLE",
      factors: {
        information: ["HEALTH"],
        mitigation: "PARTLY",
        recipient: "STAFF_ONLY",
        viewed: "YES",
      },
      reason: "Only colleagues saw it and the email was recalled.",
    },
  },
  References: { as: AUTHOR, variables: { includeArchived: true } },
  RemoveUserFromGroup: {
    as: ADMIN,
    variables: { groupId: "group-2", userId: APPROVER },
  },
  RemoveUserMfaFactor: {
    as: ADMIN,
    variables: { methodId: "totp", userId: APPROVER },
  },
  RenameCategory: {
    as: ADMIN,
    variables: {
      id: "category-workplace",
      name: "Offices",
      slug: "offices",
    },
  },
  RenameTemplate: {
    as: ADMIN,
    variables: { id: "template-1", name: "Standard Policy, 2026" },
  },
  RenameUserMfaFactor: {
    as: ADMIN,
    variables: { label: "Spare phone", methodId: "totp", userId: ADMIN },
  },
  ReorderAppendices: {
    as: AUTHOR,
    variables: {
      orderedIds: ["appendix-3", "appendix-2"],
      policyVersionId: "version-3",
    },
  },
  ReportCase: { as: OFFICER, variables: { caseId: "case-1" } },
  ReportCases: { as: OFFICER, variables: {} },
  RequestStepUpOtp: { as: ADMIN },
  ResendWelcomeEmail: { as: ADMIN, variables: { userId: READER } },
  ResetUserPassword: {
    as: ADMIN,
    variables: { newPassword: "a new password", userId: AUTHOR },
  },
  ResolveUserLabels: {
    as: READER,
    variables: { ids: [AUTHOR, "user-nobody"] },
  },
  RetireTemplate: { as: ADMIN, variables: { id: "template-2" } },
  RevokeRole: { as: ADMIN, variables: { role: "approver", userId: APPROVER } },
  RevokeUserSessions: {
    as: ADMIN,
    variables: { reason: "Lost laptop", userId: AUTHOR },
  },
  SaveDraft: {
    as: AUTHOR,
    variables: {
      contentJson: JSON.stringify({ root: { children: [], type: "root" } }),
      policyId: "policy-2",
    },
  },
  SearchAndAnswer: {
    as: READER,
    refused: AI_DOWN,
    variables: { question: "How do I book a desk?" },
  },
  SearchUsers: { as: AUTHOR, variables: { limit: 5, query: "charlie" } },
  SetAiEnabled: { as: ADMIN, refused: AI_DOWN, variables: { enabled: true } },
  SetAiProviderCredential: {
    as: ADMIN,
    refused: AI_DOWN,
    variables: { credential: "sk-mock-0000" },
  },
  SetAiRetrievalConfig: {
    as: ADMIN,
    refused: AI_DOWN,
    variables: { topK: 6 },
  },
  SetCaseDiscoveryDate: {
    as: OFFICER,
    variables: { caseId: "case-1", discoveredOn: "2026-04-01" },
  },
  SetCaseStatus: {
    as: OFFICER,
    variables: { caseId: "case-1", status: "IN_REVIEW" },
  },
  SetCategoryDefaults: {
    as: ADMIN,
    variables: {
      defaultTemplateId: "template-1",
      defaultTemplateNone: false,
      defaultWorkflowId: "workflow-1",
      id: "category-people",
    },
  },
  SetCategoryGovernance: {
    as: ADMIN,
    variables: {
      ackEveryone: true,
      ackTriggers: "ON_PUBLISH",
      id: "category-people",
      owners: [AUTHOR],
      reviewCadence: "ANNUAL",
    },
  },
  SetCategoryRuleset: {
    as: ADMIN,
    variables: {
      categoryId: "category-travel",
      rules: [
        {
          ack: "ALLOW",
          approve: "BLANK",
          author: "BLANK",
          read: "ALLOW",
          subjectKind: "EVERYONE",
          subjectRef: "",
        },
      ],
    },
  },
  SetContactBlockArchived: {
    as: ADMIN,
    variables: { archived: false, id: "contact-block-2" },
  },
  SetDefinitionArchived: {
    as: ADMIN,
    variables: { archived: false, id: "definition-3" },
  },
  SetEmailServiceConfig: {
    as: ADMIN,
    variables: {
      input: {
        apiKey: "invented-api-key",
        domain: "mail.example.org",
        enabled: true,
        fromAddress: "steward@example.org",
        provider: "smtp",
        region: "",
      },
    },
  },
  SetGlobalSettings: {
    as: ADMIN,
    variables: {
      input: {
        announcement: { enabled: true, level: "info", message: "Welcome." },
        maintenance: { enabled: false, message: "" },
      },
    },
  },
  SetReferenceArchived: {
    as: ADMIN,
    variables: { archived: false, id: "reference-3" },
  },
  SetUserPolicyOverride: {
    as: ADMIN,
    variables: {
      effect: "DENY",
      policyNumber: "POL-LEAVE-000001",
      userId: AUTHOR,
    },
  },
  SignalWorkflow: {
    as: APPROVER,
    variables: {
      comment: "Reads well.",
      policyVersionId: "version-4",
      runId: "run-1",
      signal: "SIGNAL_TYPE_APPROVE",
      taskId: "task-1",
    },
  },
  SimulateCategory: {
    as: ADMIN,
    variables: { categoryId: "category-facilities", userId: READER },
  },
  SpCertificate: { as: ADMIN },
  StartDomainVerification: {
    as: ADMIN,
    variables: { domain: "partner.example.net", rotate: false },
  },
  StartImpersonation: {
    as: ADMIN,
    variables: { reason: "Checking her view", userId: READER },
  },
  StopImpersonation: { as: ADMIN },
  SubmitDraftGeneration: {
    as: AUTHOR,
    refused: AI_DOWN,
    variables: {
      input: {
        brief: "How staff book travel.",
        sections: [{ key: "purpose", order: 0, title: "Purpose" }],
      },
    },
  },
  SubmitPolicyReview: {
    as: AUTHOR,
    refused: AI_DOWN,
    variables: {
      input: {
        policyId: "policy-2",
        sections: [
          { content: "Work use only.", key: "purpose", title: "Purpose" },
        ],
        versionId: "version-3",
      },
    },
  },
  SubmitWorkflow: {
    as: AUTHOR,
    variables: {
      ancestorCategoryIds: [],
      categoryId: "category-records",
      policyId: "policy-2",
      policyVersionId: "version-3",
    },
  },
  Templates: { as: AUTHOR, variables: {} },
  TemplateVersions: { as: ADMIN, variables: { templateId: "template-1" } },
  TopPolicyQuestions: { as: READER, variables: { limit: 6 } },
  UpcomingApprovals: { as: ADMIN },
  UpdateAppendix: {
    as: AUTHOR,
    variables: {
      contentJson: JSON.stringify({ text: "Reviewed every year." }),
      id: "appendix-2",
      title: "Review notes",
    },
  },
  UpdateCaseNotice: {
    as: OFFICER,
    variables: {
      caseId: "case-3",
      noticeId: "case-notice-1",
      sentOn: "2026-05-01",
      status: "SENT",
    },
  },
  UpdateContactBlock: {
    as: ADMIN,
    variables: {
      block: { label: "IT Service Desk", phone: "+1 555-0100" },
      id: "contact-block-1",
    },
  },
  UpdateDefinition: {
    as: ADMIN,
    variables: {
      id: "definition-1",
      input: {
        categoryId: "category-information",
        definition: "The longest a system may stay down after an incident.",
        term: "RTO",
      },
    },
  },
  UpdateIdPConnection: {
    as: ADMIN,
    variables: {
      allowLocal: true,
      domain: "partner.example.net",
      jitEnabled: false,
    },
  },
  UpdateMyProfile: {
    as: READER,
    variables: { firstName: "Erin", lastName: "Reader" },
  },
  UpdateReference: {
    as: ADMIN,
    variables: {
      id: "reference-1",
      input: { clause: "Section 5", kind: "STANDARD", label: "RFC 2119" },
    },
  },
  UpdateTemplateVersionSections: {
    as: ADMIN,
    variables: { id: "template-version-3", sections: [SECTION] },
  },
  UpdateUserProfile: {
    as: ADMIN,
    variables: {
      email: "erin@example.org",
      name: "Erin Reader",
      userId: READER,
    },
  },
  UpdateWorkflowDef: {
    as: ADMIN,
    variables: {
      id: "workflow-1",
      name: "Finance sign-off",
      stages: [
        {
          approvers: [APPROVER],
          id: "workflow-stage-1",
          name: "Finance sign-off",
          quorum: "one",
        },
      ],
    },
  },
  UserFactors: { as: ADMIN, variables: { userId: APPROVER } },
  Users: { as: ADMIN, variables: { includeDeleted: true } },
  VerifyAuditChain: {
    as: ADMIN,
    variables: { fromRecordId: "1", toRecordId: "5" },
  },
  VerifyDomain: { as: ADMIN, variables: { domain: "partner.example.net" } },
  WorkflowDef: { as: ADMIN, variables: { id: "workflow-1" } },
  WorkflowDefs: { as: ADMIN },
  WorkflowStatus: { as: AUTHOR, variables: { policyVersionId: "version-4" } },
};

/** The one subscription: sent over the websocket, as the web subscribes. */
const SUBSCRIPTIONS: Record<string, Case> = {
  AiJobResult: {
    as: AUTHOR,
    refused: AI_DOWN,
    variables: { jobId: "ai-job-1" },
  },
};

let base = "";
let server: RunningMockServer;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});

/** Fresh data and a fresh bearer session for `personId`. */
const fresh = async (personId: string): Promise<Signed> => {
  await control(base, { kind: "reset" });
  return signInAs(base, personId);
};

type Errors = { extensions?: { code?: string }; message: string }[];

const assertAnswered = (name: string, expected: Case, errors?: Errors) => {
  const problems = (errors ?? []).filter(
    (error) =>
      error.extensions?.code === "GRAPHQL_VALIDATION_FAILED" ||
      error.message.includes("Cannot return null for non-nullable field"),
  );
  assert.deepEqual(problems, [], `${name}: ${JSON.stringify(problems)}`);
  const codes = (errors ?? []).map((error) => error.extensions?.code);
  assert.deepEqual(
    codes,
    expected.refused ? [expected.refused] : [],
    `${name}: ${JSON.stringify(errors)}`,
  );
};

describe("steward-web's operations", () => {
  it("are all here and each has a case", () => {
    assert.equal(webOperations.length, 154);
    const names = webOperations.toSorted();
    const covered = [...Object.keys(cases), ...Object.keys(SUBSCRIPTIONS)];
    assert.deepEqual(names, covered.toSorted());
  });

  for (const name of webOperations) {
    const expected = cases[name];
    if (!expected) continue;
    it(`answers ${name}`, async () => {
      const signed = await fresh(expected.as);
      const { body } = await query(
        base,
        documentOf(name),
        signed,
        expected.variables,
      );
      assertAnswered(name, expected, body.errors as Errors | undefined);
      if (expected.refused || expected.answersNull) return;
      // The seed has a record behind every id the cases name, so no root field answers null.
      for (const [field, value] of Object.entries(body.data ?? {}))
        assert.notEqual(value, null, `${name}: ${field} answered null`);
      // Every audit entry, seeded or written by the call, uses a name a service really writes.
      const unknown = stewardData()
        .audit.map((entry) => entry.action)
        .filter((action) => !auditActions.has(action));
      assert.deepEqual(unknown, [], `${name} wrote unknown audit actions`);
    });
  }

  for (const [name, expected] of Object.entries(SUBSCRIPTIONS)) {
    it(`answers the ${name} subscription`, async () => {
      const signed = await fresh(expected.as);
      const ws = await openSocket(base, "graphql-transport-ws");
      ws.send({
        payload: { authToken: signed.token },
        type: "connection_init",
      });
      await ws.next("connection_ack");
      ws.send({
        id: "1",
        payload: { query: documentOf(name), variables: expected.variables },
        type: "subscribe",
      });
      // A refusal at subscribe time comes back as one result carrying the errors.
      const answer = await ws.next("next");
      ws.socket.close();
      const payload = answer.payload as { errors?: Errors } | Errors;
      assertAnswered(
        name,
        expected,
        Array.isArray(payload) ? payload : payload.errors,
      );
    });
  }
});
