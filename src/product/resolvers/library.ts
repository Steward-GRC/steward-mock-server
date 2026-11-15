// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The library's structure: the category tree (site admin), templates and their versions
// (template admins; reading them takes authoring rights in the owning category), approval
// workflows (template admins), and the contact, reference and definition libraries.

import type {
  Category,
  ContactBlock,
  Definition,
  Reference,
  Section,
  Template,
  WorkflowStage,
} from "#product/data/library.ts";
import type { StewardPerson } from "#product/data/people.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { createLogger } from "#core/log.ts";
import { canAuthorIn } from "#product/access.ts";
import { documentCounts, stranded } from "#product/category-types.ts";
import { raci } from "#product/data/library.ts";
import { byTitle, usedByPolicies, type VersionLinks } from "#product/links.ts";
import {
  caller,
  data,
  forbidden,
  found,
  isSiteAdmin,
  newId,
  now,
  people,
  record,
  refuse,
  siteAdmin,
  withAnyRole,
  workflowDefinitionInUse,
  workflowDefinitionInUseByCategory,
  workflowDefinitionNotFound,
} from "#product/resolvers/shared.ts";
import { numberTemplateForPublish } from "#product/version-numbers.ts";
import { MAX_WORKING_DAYS } from "#product/workcal.ts";

const log = createLogger("steward-library");

/** The deepest the category tree goes, a root being depth 1 (steward-core's guard). */
const MAX_DEPTH = 3;

const categoryFor = (id: string): Category =>
  found(
    data().categories.find((c) => c.id === id),
    "category",
  );

const depthOf = (id: null | string): number => {
  let depth = 0;
  let at = id ? data().categories.find((c) => c.id === id) : undefined;
  while (at && depth <= data().categories.length) {
    depth += 1;
    const parentId = at.parentId;
    at = parentId
      ? data().categories.find((c) => c.id === parentId)
      : undefined;
  }
  return depth;
};

const subtreeOf = (id: string): Category[] => {
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of data().categories)
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        grew = true;
      }
  }
  return data().categories.filter((c) => ids.has(c.id));
};

/** The next free place among a parent's children: one past the highest, or zero for the first. */
const nextOrder = (parentId: null | string, except?: string) =>
  Math.max(
    -1,
    ...data()
      .categories.filter((c) => c.parentId === parentId && c.id !== except)
      .map((c) => c.order),
  ) + 1;

/** A parent's children in their stored order, then by name and id as steward-core breaks ties. */
const childrenOf = (parentId: null | string): Category[] =>
  data()
    .categories.filter((c) => c.parentId === parentId)
    .toSorted(
      (a, b) =>
        a.order - b.order ||
        a.name.localeCompare(b.name, "en") ||
        a.id.localeCompare(b.id, "en"),
    );

/** Categories depth first, each parent's children in order, as the gateway's categoryTree walks them. */
const walkFrom = (parentId: null | string): Category[] =>
  childrenOf(parentId).flatMap((c) => [c, ...walkFrom(c.id)]);

const heightOf = (id: string): number => {
  const children = data().categories.filter((c) => c.parentId === id);
  return 1 + Math.max(0, ...children.map((c) => heightOf(c.id)));
};

const slugTaken = (parentId: null | string, slug: string, except?: string) =>
  data().categories.some(
    (c) => c.parentId === parentId && c.slug === slug && c.id !== except,
  );

const categorySubject = (c: Category) => ({
  groupId: c.id,
  groupName: c.name,
  id: c.id,
  kind: "category",
  label: c.name,
});

/** May the person read a template (the gateway's authorizeTemplateRead)? */
const canReadTemplate = (person: StewardPerson, template: Template) =>
  template.ownerCategoryId
    ? canAuthorIn(person, template.ownerCategoryId)
    : isSiteAdmin(person) ||
      data().categories.some((c) => canAuthorIn(person, c.id));

const templateFor = (id: string): Template =>
  found(
    data().templates.find((t) => t.id === id),
    "template",
  );

const readableTemplate = (context: Context, id: string): Template => {
  const template = data().templates.find((t) => t.id === id);
  // An unknown template is refused the same way as one the caller can't read.
  if (!template || !canReadTemplate(caller(context), template))
    throw forbidden();
  return template;
};

const templateVersionFor = (id: string) =>
  found(
    data().templateVersions.find((v) => v.id === id),
    "template version",
  );

const templateAdmin = (context: Context) =>
  withAnyRole(context, "template-admin");

const libraryAdmin = (context: Context) =>
  withAnyRole(context, "template-admin", "compliance-admin");

interface SectionInput {
  blocks: { contentJson?: null | string; type: string }[];
  key: string;
  level?: null | number;
  order: number;
  required?: boolean | null;
  title: string;
}

const sectionsOf = (input: SectionInput[]): Section[] =>
  input.map((s) => ({
    blocks: s.blocks.map((b) => ({
      contentJson: b.contentJson ?? null,
      type: b.type,
    })),
    key: s.key,
    level: s.level ?? 1,
    order: s.order,
    required: s.required ?? false,
    title: s.title,
  }));

const draftOnly = (id: string) => {
  const version = templateVersionFor(id);
  if (version.status !== "draft")
    throw refuse(
      "FAILED_PRECONDITION",
      "Only a draft template version can change.",
    );
  return version;
};

interface StageInput {
  approvers: string[];
  approversByCategory?: { approverIds: string[]; categoryId: string }[] | null;
  escalateAfterDays?: null | number;
  groupUnits?:
    | { groupId: string; internalQuorum: string; memberUserIds: string[] }[]
    | null;
  id?: null | string;
  name: string;
  pinnedLast?: boolean | null;
  quorum: string;
  quorumN?: null | number;
  rejectOnSlaBreach?: boolean | null;
  remindEveryDays?: null | number;
  slaDays?: null | number;
  vetoUserIds?: null | string[];
}

/**
 * steward-workflow's Stage.Validate for the n-of-m quorum, applied when a definition is saved: an
 * nofm stage needs an N of at least one, any other quorum takes none, and a stage that names
 * approvers cannot ask for more of them than it names (a stage with none is a draft).
 */
const checkQuorum = (s: StageInput) => {
  const n = s.quorumN ?? 0;
  if (s.quorum === "nofm" && n < 1)
    throw refuse(
      "BAD_USER_INPUT",
      `stage "${s.name}": quorum_n must be >= 1 when quorum is "nofm"`,
    );
  if (s.quorum !== "nofm" && n !== 0)
    throw refuse(
      "BAD_USER_INPUT",
      `stage "${s.name}": quorum_n only valid when quorum is "nofm"`,
    );
  if (s.quorum === "nofm" && s.approvers.length > 0 && n > s.approvers.length)
    throw refuse(
      "BAD_USER_INPUT",
      `stage "${s.name}": quorum_n (${String(n)}) exceeds approver count (${String(s.approvers.length)})`,
    );
};

/**
 * A stage's veto people must be among its approvers (steward-mock-server#223): a vetoer holds a
 * seat of the stage's pool, there are no veto-only seats, and site admin or root does not count.
 * The save can check the explicit lists only: the stage's approvers, those named per category and
 * the members of its group units. Whether a named person is seated for a given policy is decided
 * at submit, where an unseated vetoer simply holds no veto.
 */
const checkVetoPeople = (s: StageInput) => {
  const named = new Set([
    ...s.approvers,
    ...(s.approversByCategory ?? []).flatMap((c) => c.approverIds),
    ...(s.groupUnits ?? []).flatMap((g) => g.memberUserIds),
  ]);
  const strangers = (s.vetoUserIds ?? []).filter((id) => !named.has(id));
  if (strangers.length > 0)
    throw refuse(
      "BAD_USER_INPUT",
      `stage "${s.name}": a veto person must be one of the stage's approvers (${strangers.join(", ")})`,
    );
};

/** A stage's SLA counts working days (steward-mock-server#227): no more than a year's worth. */
const checkSla = (s: StageInput) => {
  const days = s.slaDays ?? 0;
  if (days < 0 || days > MAX_WORKING_DAYS)
    throw refuse(
      "BAD_USER_INPUT",
      `stage "${s.name}": sla_days must be between 0 and ${String(MAX_WORKING_DAYS)} working days`,
    );
};

/**
 * The stage's reminder and escalation days (steward-mock-server#245), whole working days: each is
 * 0 (off) to a year's worth, and either one needs the stage's slaDays (nothing is overdue without
 * a due date) and a stage that does not reject at due (the run would be rejected before a
 * reminder could fire). Neither ever approves or rejects.
 */
const checkReminders = (s: StageInput) => {
  const fields = [
    ["remind_every_days", s.remindEveryDays ?? 0],
    ["escalate_after_days", s.escalateAfterDays ?? 0],
  ] as const;
  for (const [name, days] of fields)
    if (days < 0 || days > MAX_WORKING_DAYS)
      throw refuse(
        "BAD_USER_INPUT",
        `stage "${s.name}": ${name} must be between 0 and ${String(MAX_WORKING_DAYS)} working days`,
      );
  for (const [name, days] of fields) {
    if (days === 0) continue;
    if ((s.slaDays ?? 0) <= 0)
      throw refuse(
        "BAD_USER_INPUT",
        `stage "${s.name}": ${name} needs sla_days to be set`,
      );
    if (s.rejectOnSlaBreach)
      throw refuse(
        "BAD_USER_INPUT",
        `stage "${s.name}": ${name} cannot be set on a stage with reject_on_sla_breach, which rejects at the due date`,
      );
  }
};

const stagesOf = (input: StageInput[]): WorkflowStage[] => {
  for (const s of input) {
    checkSla(s);
    checkReminders(s);
    checkQuorum(s);
    checkVetoPeople(s);
  }
  return input.map((s) => ({
    approvers: [...s.approvers],
    approversByCategory: (s.approversByCategory ?? []).map((c) => ({
      approverIds: [...c.approverIds],
      categoryId: c.categoryId,
    })),
    escalateAfterDays: s.escalateAfterDays ?? 0,
    groupUnits: (s.groupUnits ?? []).map((g) => ({
      ...g,
      memberUserIds: [...g.memberUserIds],
    })),
    id: s.id ?? newId("workflow-stage"),
    name: s.name,
    pinnedLast: s.pinnedLast ?? false,
    quorum: s.quorum,
    quorumN: s.quorumN ?? 0,
    rejectOnSlaBreach: s.rejectOnSlaBreach ?? false,
    remindEveryDays: s.remindEveryDays ?? 0,
    slaDays: s.slaDays ?? null,
    vetoUserIds: [...new Set(s.vetoUserIds)],
  }));
};

const workflowFor = (id: string) =>
  found(
    data().workflowDefs.find((w) => w.id === id && !w.archived),
    "workflow",
  );

/** How many policies link to a library entry. */
const usedBy = (pick: (links: VersionLinks) => string[], id: string) =>
  usedByPolicies(data().links, data().policies, pick, id);

const withContactUse = (block: ContactBlock) => ({
  ...block,
  usedByCount: usedBy((l) => l.contactBlockIds, block.id),
});
const withReferenceUse = (reference: Reference) => ({
  ...reference,
  usedByCount: usedBy((l) => l.referenceIds, reference.id),
});
const withDefinitionUse = (definition: Definition) => ({
  ...definition,
  usedByCount: usedBy((l) => l.definitionIds, definition.id),
});

/**
 * A definition is identified by its title, so the title is unique across the whole library (the
 * categories only scope who may attach it), ignoring case and surrounding spaces. Returns the
 * trimmed title, or refuses an empty or a taken one.
 */
const uniqueTerm = (given: string, except?: string): string => {
  const term = given.trim();
  if (term === "")
    throw refuse("BAD_USER_INPUT", "A definition needs a title.");
  const taken = data().definitions.some(
    (d) =>
      d.id !== except && d.term.trim().toLowerCase() === term.toLowerCase(),
  );
  if (taken)
    throw refuse(
      "ALREADY_EXISTS",
      `A definition titled "${term}" already exists.`,
    );
  return term;
};

// steward-core audits no contact block change, so the contact block mutations write no entry.
const contactFor = (id: string) =>
  found(
    data().contactBlocks.find((b) => b.id === id),
    "contact block",
  );

/** A library admin, or the entry's creator (reference_resolver's and definition's check). */
const editorOf = (
  context: Context,
  entry: { createdByUserId: null | string },
): StewardPerson => {
  const person = caller(context);
  if (entry.createdByUserId === person.id) return person;
  return libraryAdmin(context);
};

const referenceFor = (id: string) =>
  found(
    data().references.find((r) => r.id === id),
    "reference",
  );

const definitionFor = (id: string) =>
  found(
    data().definitions.find((d) => d.id === id),
    "definition",
  );

interface ContactInput {
  department?: null | string;
  email?: null | string;
  hours?: null | string;
  label: string;
  name?: null | string;
  notes?: null | string;
  phone?: null | string;
  role?: null | string;
}

const contactFields = (block: ContactInput) => ({
  department: block.department ?? null,
  email: block.email ?? null,
  hours: block.hours ?? null,
  label: block.label,
  name: block.name ?? null,
  notes: block.notes ?? null,
  phone: block.phone ?? null,
  role: block.role ?? null,
});

interface ReferenceInput {
  body?: null | string;
  clause?: null | string;
  kind: Reference["kind"];
  label: string;
  url?: null | string;
}

const referenceFields = (input: ReferenceInput) => ({
  body: input.body ?? null,
  clause: input.clause ?? null,
  kind: input.kind,
  label: input.label,
  url: input.url ?? null,
});

const librarySubject = (kind: string, id: string, label: string) => ({
  id,
  kind,
  label,
});

/**
 * steward-gateway's validateCategoryOwners: every owner is a person, a user id the directory
 * knows. A group, Everyone or any other subject (anything shaped like "kind:name") is refused, and
 * so is an id with no user; a repeated id counts once.
 */
const validatedOwners = (owners: string[]): string[] => {
  const seen = new Set<string>();
  for (const owner of owners) {
    if (seen.has(owner)) continue;
    seen.add(owner);
    if (owner === "" || owner.includes(":"))
      throw refuse(
        "BAD_USER_INPUT",
        "category owners must be people: a group or Everyone cannot own a category",
      );
    if (!people().some((p) => p.id === owner))
      throw refuse("BAD_USER_INPUT", `category owner ${owner} is not a user`);
  }
  return [...seen];
};

export const libraryResolvers: Resolvers = {
  Mutation: {
    archiveWorkflowDef: (_root, given: { id: string }, context: Context) => {
      const admin = templateAdmin(context);
      const workflow = workflowFor(given.id);
      workflow.archived = true;
      record(
        "workflow_def.archived",
        admin,
        librarySubject("workflow_def", workflow.id, workflow.name),
      );
      return true;
    },
    createCategory: (
      _root,
      given: { name: string; parentId?: null | string; slug: string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const parentId = given.parentId ?? null;
      if (parentId) categoryFor(parentId);
      if (depthOf(parentId) + 1 > MAX_DEPTH)
        throw refuse(
          "FAILED_PRECONDITION",
          `Categories go at most ${String(MAX_DEPTH)} levels deep.`,
        );
      if (slugTaken(parentId, given.slug))
        throw refuse(
          "ALREADY_EXISTS",
          `A category with the slug "${given.slug}" already exists here.`,
        );
      const created: Category = {
        ackEveryone: false,
        ackEveryoneSet: false,
        ackTriggers: "NONE",
        approverRule: [],
        authorRule: [],
        defaultTemplateId: null,
        defaultTemplateLocked: false,
        defaultTemplateNone: false,
        defaultWorkflowId: null,
        documentTypes: "BOTH",
        exclusionGroupIds: null,
        id: newId("category"),
        idpGroupIds: null,
        name: given.name,
        order: nextOrder(parentId),
        owners: [],
        parentId,
        reviewCadence: "NONE",
        reviewDate: null,
        // Everyone: Read is the default on every new category (core#98).
        rules: [raci("EVERYONE", "", ["ALLOW", "BLANK", "BLANK", "BLANK"])],
        slug: given.slug,
      };
      data().categories.push(created);
      record("category.created", admin, categorySubject(created));
      return created;
    },
    createContactBlock: (
      _root,
      given: { block: ContactInput },
      context: Context,
    ) => {
      libraryAdmin(context);
      const block: ContactBlock = {
        ...contactFields(given.block),
        archived: false,
        id: newId("contact-block"),
      };
      data().contactBlocks.push(block);
      return withContactUse(block);
    },
    createDefinition: (
      _root,
      given: {
        input: { categoryId: string; definition: string; term: string };
      },
      context: Context,
    ) => {
      const person = caller(context);
      categoryFor(given.input.categoryId);
      const term = uniqueTerm(given.input.term);
      const definition: Definition = {
        ...given.input,
        archived: false,
        createdByUserId: person.id,
        id: newId("definition"),
        term,
      };
      data().definitions.push(definition);
      record(
        "definition.created",
        person,
        librarySubject("definition", definition.id, definition.term),
      );
      return withDefinitionUse(definition);
    },
    createReference: (
      _root,
      given: { input: ReferenceInput },
      context: Context,
    ) => {
      const person = caller(context);
      const reference: Reference = {
        ...referenceFields(given.input),
        archived: false,
        createdByUserId: person.id,
        id: newId("reference"),
      };
      data().references.push(reference);
      record(
        "reference.created",
        person,
        librarySubject("reference", reference.id, reference.label),
      );
      return withReferenceUse(reference);
    },
    createTemplate: (
      _root,
      given: { name: string; ownerCategoryId?: null | string },
      context: Context,
    ) => {
      const admin = templateAdmin(context);
      if (given.ownerCategoryId) categoryFor(given.ownerCategoryId);
      const template: Template = {
        code: `TPL-${String(data().templates.length + 1).padStart(3, "0")}`,
        id: newId("template"),
        name: given.name,
        ownerCategoryId: given.ownerCategoryId ?? null,
        retiredAt: null,
      };
      data().templates.push(template);
      record(
        "template.created",
        admin,
        librarySubject("template", template.id, template.name),
      );
      return template;
    },
    createTemplateVersion: (
      _root,
      given: { sections: SectionInput[]; templateId: string },
      context: Context,
    ) => {
      const admin = templateAdmin(context);
      const template = templateFor(given.templateId);
      const versionNo =
        Math.max(
          0,
          ...data()
            .templateVersions.filter((v) => v.templateId === template.id)
            .map((v) => v.versionNo),
        ) + 1;
      const version = {
        createdAt: now(),
        id: newId("template-version"),
        sections: sectionsOf(given.sections),
        status: "draft",
        templateId: template.id,
        versionNo,
      };
      data().templateVersions.push(version);
      record(
        "template_version.created",
        admin,
        librarySubject("template", template.id, template.name),
      );
      return version;
    },
    createWorkflowDef: (
      _root,
      given: {
        description?: null | string;
        name: string;
        stages: StageInput[];
      },
      context: Context,
    ) => {
      const admin = templateAdmin(context);
      const workflow = {
        archived: false,
        description: given.description ?? null,
        id: newId("workflow"),
        name: given.name,
        stages: stagesOf(given.stages),
        version: 1,
      };
      data().workflowDefs.push(workflow);
      record(
        "workflow_def.created",
        admin,
        librarySubject("workflow_def", workflow.id, workflow.name),
      );
      return workflow;
    },
    deleteCategory: (_root, given: { id: string }, context: Context) => {
      const admin = siteAdmin(context);
      const category = categoryFor(given.id);
      const ids = new Set(subtreeOf(category.id).map((c) => c.id));
      if (data().policies.some((p) => ids.has(p.homeCategoryId)))
        throw refuse(
          "FAILED_PRECONDITION",
          "This category or one below it still holds policies.",
        );
      data().categories = data().categories.filter((c) => !ids.has(c.id));
      record("category.deleted", admin, categorySubject(category));
      return true;
    },
    /**
     * core's DeleteContactBlock: deletes the block and the join tables cascade, so every policy
     * version that linked to it is detached, never refused. No audit entry (core audits none).
     */
    deleteContactBlock: (_root, given: { id: string }, context: Context) => {
      libraryAdmin(context);
      const block = contactFor(given.id);
      data().contactBlocks = data().contactBlocks.filter((b) => b !== block);
      for (const links of Object.values(data().links))
        links.contactBlockIds = links.contactBlockIds.filter(
          (id) => id !== block.id,
        );
      return true;
    },
    deleteDefinition: (_root, given: { id: string }, context: Context) => {
      const definition = definitionFor(given.id);
      const person = editorOf(context, definition);
      if (withDefinitionUse(definition).usedByCount > 0)
        throw refuse(
          "FAILED_PRECONDITION",
          "This definition is in use; archive it instead.",
        );
      data().definitions = data().definitions.filter((d) => d !== definition);
      record(
        "definition.deleted",
        person,
        librarySubject("definition", definition.id, definition.term),
      );
      return true;
    },
    deleteReference: (_root, given: { id: string }, context: Context) => {
      const reference = referenceFor(given.id);
      const person = editorOf(context, reference);
      if (withReferenceUse(reference).usedByCount > 0)
        throw refuse(
          "FAILED_PRECONDITION",
          "This reference is in use; archive it instead.",
        );
      data().references = data().references.filter((r) => r !== reference);
      record(
        "reference.deleted",
        person,
        librarySubject("reference", reference.id, reference.label),
      );
      return true;
    },
    deleteTemplate: (_root, given: { id: string }, context: Context) => {
      const admin = templateAdmin(context);
      const template = templateFor(given.id);
      if (data().policies.some((p) => p.templateId === template.id))
        throw refuse(
          "FAILED_PRECONDITION",
          "A policy still uses this template; retire it instead.",
        );
      data().templates = data().templates.filter((t) => t !== template);
      data().templateVersions = data().templateVersions.filter(
        (v) => v.templateId !== template.id,
      );
      record(
        "template.deleted",
        admin,
        librarySubject("template", template.id, template.name),
      );
      return true;
    },
    deleteWorkflowDef: (_root, given: { id: string }, context: Context) => {
      const admin = templateAdmin(context);
      const store = data();
      log.debug("deleteWorkflowDef: start", { id: given.id });
      // The gateway checks core's category defaults before it asks the workflow service.
      const categoryCount = store.categories.filter(
        (c) => c.defaultWorkflowId === given.id,
      ).length;
      if (categoryCount > 0) {
        log.info("deleteWorkflowDef refused: category default", {
          categoryCount,
          id: given.id,
        });
        throw workflowDefinitionInUseByCategory(given.id, categoryCount);
      }
      if (!store.workflowDefs.some((w) => w.id === given.id)) {
        log.info("deleteWorkflowDef refused: not found", { id: given.id });
        throw workflowDefinitionNotFound(given.id);
      }
      const runCount = store.runs.filter(
        (r) => r.workflowDefId === given.id,
      ).length;
      const overrideCount = store.policies.filter(
        (p) => p.workflowDefId === given.id,
      ).length;
      if (runCount > 0 || overrideCount > 0) {
        log.info("deleteWorkflowDef refused: in use", {
          id: given.id,
          overrideCount,
          runCount,
        });
        throw workflowDefinitionInUse(given.id, runCount, overrideCount);
      }
      // The mock keeps one record per definition, so this removes every version with it.
      store.workflowDefs = store.workflowDefs.filter((w) => w.id !== given.id);
      record(
        "workflow_def.deleted",
        admin,
        librarySubject("workflow_def", given.id, given.id),
      );
      log.info("deleteWorkflowDef: deleted", { id: given.id });
      return true;
    },
    discardTemplateVersion: (
      _root,
      given: { id: string },
      context: Context,
    ) => {
      templateAdmin(context);
      const version = draftOnly(given.id);
      data().templateVersions = data().templateVersions.filter(
        (v) => v !== version,
      );
      return true;
    },
    moveCategory: (
      _root,
      given: { categoryId: string; newParentId?: null | string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const category = categoryFor(given.categoryId);
      const parentId = given.newParentId ?? null;
      if (parentId) {
        categoryFor(parentId);
        if (subtreeOf(category.id).some((c) => c.id === parentId))
          throw refuse(
            "BAD_USER_INPUT",
            "A category can't move under itself or one of its own.",
          );
      }
      if (depthOf(parentId) + heightOf(category.id) > MAX_DEPTH)
        throw refuse(
          "FAILED_PRECONDITION",
          `Categories go at most ${String(MAX_DEPTH)} levels deep.`,
        );
      category.order = nextOrder(parentId, category.id);
      category.parentId = parentId;
      record("category.moved", admin, categorySubject(category));
      return category;
    },
    publishTemplateVersion: (
      _root,
      given: { id: string },
      context: Context,
    ) => {
      const admin = templateAdmin(context);
      const version = draftOnly(given.id);
      // numbered against the highest published version before it, then published
      numberTemplateForPublish(version);
      version.status = "published";
      version.publishedAt = now();
      const template = templateFor(version.templateId);
      record(
        "template_version.published",
        admin,
        librarySubject("template", template.id, template.name),
      );
      return version;
    },
    renameCategory: (
      _root,
      given: { id: string; name: string; slug: string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const category = categoryFor(given.id);
      if (slugTaken(category.parentId, given.slug, category.id))
        throw refuse(
          "ALREADY_EXISTS",
          `A category with the slug "${given.slug}" already exists here.`,
        );
      category.name = given.name;
      category.slug = given.slug;
      record("category.renamed", admin, categorySubject(category));
      return category;
    },
    renameTemplate: (
      _root,
      given: { id: string; name: string },
      context: Context,
    ) => {
      const admin = templateAdmin(context);
      const template = templateFor(given.id);
      template.name = given.name;
      template.renamedAt = now();
      record(
        "template.renamed",
        admin,
        librarySubject("template", template.id, template.name),
      );
      return template;
    },
    reorderCategories: (
      _root,
      given: { orderedIds: string[]; parentId?: null | string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const parentId = given.parentId ?? null;
      const parent = parentId ? categoryFor(parentId) : null;
      const siblings = childrenOf(parentId);
      const listed = new Set(given.orderedIds);
      // every child exactly once, else nothing changes
      if (
        given.orderedIds.length !== siblings.length ||
        listed.size !== given.orderedIds.length ||
        siblings.some((c) => !listed.has(c.id))
      )
        throw refuse(
          "BAD_USER_INPUT",
          "orderedIds must list every child of the parent exactly once.",
        );
      const byId = new Map(siblings.map((c) => [c.id, c]));
      for (const [position, id] of given.orderedIds.entries()) {
        const child = byId.get(id);
        if (child) child.order = position;
      }
      record(
        "category.reordered",
        admin,
        parent
          ? categorySubject(parent)
          : { id: "root", kind: "category", label: "Top level" },
      );
      return childrenOf(parentId);
    },
    retireTemplate: (_root, given: { id: string }, context: Context) => {
      const admin = templateAdmin(context);
      const template = templateFor(given.id);
      template.retiredAt ??= now();
      record(
        "template.retired",
        admin,
        librarySubject("template", template.id, template.name),
      );
      return template;
    },
    setCategoryDefaults: (
      _root,
      given: {
        defaultTemplateId?: null | string;
        defaultTemplateNone?: boolean | null;
        defaultWorkflowId?: null | string;
        id: string;
      },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const category = categoryFor(given.id);
      if (given.defaultTemplateId) templateFor(given.defaultTemplateId);
      if (given.defaultWorkflowId) workflowFor(given.defaultWorkflowId);
      category.defaultTemplateNone = given.defaultTemplateNone === true;
      category.defaultTemplateId = category.defaultTemplateNone
        ? null
        : (given.defaultTemplateId ?? null);
      // a lock needs a template to hold to
      if (!category.defaultTemplateId) category.defaultTemplateLocked = false;
      if (given.defaultWorkflowId !== undefined)
        category.defaultWorkflowId = given.defaultWorkflowId;
      record("category.defaults_set", admin, categorySubject(category));
      return category;
    },
    setCategoryDocumentTypes: (
      _root,
      given: { documentTypes: Category["documentTypes"]; id: string },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const category = categoryFor(given.id);
      const count = stranded(category, given.documentTypes);
      if (count > 0)
        throw refuse(
          "FAILED_PRECONDITION",
          `CATEGORY_HOLDS_DOCUMENTS (${String(count)}): ${category.name} holds ${String(count)} documents it would no longer accept. Move them out first.`,
        );
      category.documentTypes = given.documentTypes;
      record("category.document_types_set", admin, categorySubject(category));
      return category;
    },
    setCategoryGovernance: (
      _root,
      given: {
        ackEveryone?: boolean | null;
        ackTriggers: Category["ackTriggers"];
        exclusionGroupIds?: null | string[];
        id: string;
        idpGroupIds?: null | string[];
        owners: string[];
        reviewCadence: Category["reviewCadence"];
        reviewDate?: null | string;
      },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const category = categoryFor(given.id);
      const owners = validatedOwners(given.owners);
      Object.assign(category, {
        ackTriggers: given.ackTriggers,
        exclusionGroupIds: given.exclusionGroupIds ?? null,
        idpGroupIds: given.idpGroupIds ?? null,
        owners,
        reviewCadence: given.reviewCadence,
        reviewDate: given.reviewDate ?? null,
      });
      if (typeof given.ackEveryone === "boolean") {
        category.ackEveryone = given.ackEveryone;
        category.ackEveryoneSet = true;
      }
      record("category.governance_updated", admin, categorySubject(category));
      return category;
    },
    setCategoryTemplateLock: (
      _root,
      given: { id: string; locked: boolean },
      context: Context,
    ) => {
      const admin = siteAdmin(context);
      const category = categoryFor(given.id);
      if (given.locked && !category.defaultTemplateId)
        throw refuse(
          "FAILED_PRECONDITION",
          "Choose a default template for this category before locking it.",
        );
      category.defaultTemplateLocked = given.locked;
      record("category.defaults_set", admin, categorySubject(category));
      return category;
    },
    setContactBlockArchived: (
      _root,
      given: { archived: boolean; id: string },
      context: Context,
    ) => {
      libraryAdmin(context);
      const block = contactFor(given.id);
      block.archived = given.archived;
      return withContactUse(block);
    },
    setDefinitionArchived: (
      _root,
      given: { archived: boolean; id: string },
      context: Context,
    ) => {
      const definition = definitionFor(given.id);
      const person = editorOf(context, definition);
      definition.archived = given.archived;
      record(
        "definition.archived",
        person,
        librarySubject("definition", definition.id, definition.term),
      );
      return withDefinitionUse(definition);
    },
    setReferenceArchived: (
      _root,
      given: { archived: boolean; id: string },
      context: Context,
    ) => {
      const reference = referenceFor(given.id);
      const person = editorOf(context, reference);
      reference.archived = given.archived;
      record(
        "reference.archived",
        person,
        librarySubject("reference", reference.id, reference.label),
      );
      return withReferenceUse(reference);
    },
    updateContactBlock: (
      _root,
      given: { block: ContactInput; id: string },
      context: Context,
    ) => {
      libraryAdmin(context);
      const block = contactFor(given.id);
      Object.assign(block, contactFields(given.block));
      return withContactUse(block);
    },
    updateDefinition: (
      _root,
      given: {
        id: string;
        input: { categoryId: string; definition: string; term: string };
      },
      context: Context,
    ) => {
      const definition = definitionFor(given.id);
      const person = editorOf(context, definition);
      categoryFor(given.input.categoryId);
      const term = uniqueTerm(given.input.term, definition.id);
      Object.assign(definition, given.input, { term });
      record(
        "definition.updated",
        person,
        librarySubject("definition", definition.id, definition.term),
      );
      return withDefinitionUse(definition);
    },
    updateReference: (
      _root,
      given: { id: string; input: ReferenceInput },
      context: Context,
    ) => {
      const reference = referenceFor(given.id);
      const person = editorOf(context, reference);
      Object.assign(reference, referenceFields(given.input));
      record(
        "reference.updated",
        person,
        librarySubject("reference", reference.id, reference.label),
      );
      return withReferenceUse(reference);
    },
    updateTemplateVersionSections: (
      _root,
      given: { id: string; sections: SectionInput[] },
      context: Context,
    ) => {
      templateAdmin(context);
      const version = draftOnly(given.id);
      version.sections = sectionsOf(given.sections);
      return version;
    },
    updateWorkflowDef: (
      _root,
      given: {
        description?: null | string;
        id: string;
        name: string;
        stages: StageInput[];
      },
      context: Context,
    ) => {
      const admin = templateAdmin(context);
      const workflow = workflowFor(given.id);
      Object.assign(workflow, {
        description: given.description ?? null,
        name: given.name,
        stages: stagesOf(given.stages),
        version: workflow.version + 1,
      });
      record(
        "workflow_def.updated",
        admin,
        librarySubject("workflow_def", workflow.id, workflow.name),
      );
      return workflow;
    },
  },
  Query: {
    category: (_root, given: { id: string }, context: Context) => {
      siteAdmin(context);
      return categoryFor(given.id);
    },
    categoryChildren: (
      _root,
      given: { parentId?: null | string },
      context: Context,
    ) => {
      caller(context);
      return childrenOf(given.parentId ?? null);
    },
    categoryDocumentCounts: (
      _root,
      given: { categoryId: string },
      context: Context,
    ) => {
      siteAdmin(context);
      categoryFor(given.categoryId);
      return documentCounts(given.categoryId);
    },
    categoryTree: (
      _root,
      given: { rootId?: null | string },
      context: Context,
    ) => {
      caller(context);
      if (!given.rootId) return walkFrom(null);
      siteAdmin(context);
      const root = categoryFor(given.rootId);
      return [root, ...walkFrom(root.id)];
    },
    contactBlocks: (
      _root,
      given: { includeArchived?: boolean | null },
      context: Context,
    ) => {
      caller(context);
      return data()
        .contactBlocks.filter((b) => given.includeArchived || !b.archived)
        .map((b) => withContactUse(b));
    },
    definitions: (
      _root,
      given: { categoryId?: null | string; includeArchived?: boolean | null },
      context: Context,
    ) => {
      caller(context);
      return data()
        .definitions.filter(
          (d) => !given.categoryId || d.categoryId === given.categoryId,
        )
        .filter((d) => given.includeArchived || !d.archived)
        .toSorted((a, b) => byTitle(a.term, b.term))
        .map((d) => withDefinitionUse(d));
    },
    latestTemplateVersion: (
      _root,
      given: { templateId: string },
      context: Context,
    ) => {
      const template = readableTemplate(context, given.templateId);
      return (
        data()
          .templateVersions.filter(
            (v) => v.templateId === template.id && v.status === "published",
          )
          .toSorted((a, b) => b.versionNo - a.versionNo)[0] ?? null
      );
    },
    references: (
      _root,
      given: { includeArchived?: boolean | null },
      context: Context,
    ) => {
      caller(context);
      return data()
        .references.filter((r) => given.includeArchived || !r.archived)
        .map((r) => withReferenceUse(r));
    },
    templates: (
      _root,
      given: { ownerCategoryId?: null | string },
      context: Context,
    ) => {
      const person = caller(context);
      return data().templates.filter(
        (t) =>
          (!given.ownerCategoryId ||
            t.ownerCategoryId === given.ownerCategoryId) &&
          canReadTemplate(person, t),
      );
    },
    templateVersions: (
      _root,
      given: { templateId: string },
      context: Context,
    ) => {
      const template = readableTemplate(context, given.templateId);
      return data()
        .templateVersions.filter((v) => v.templateId === template.id)
        .toSorted((a, b) => b.versionNo - a.versionNo);
    },
    workflowDef: (_root, given: { id: string }, context: Context) => {
      caller(context);
      return workflowFor(given.id);
    },
    workflowDefs: (_root, _given, context: Context) => {
      caller(context);
      return data().workflowDefs.filter((w) => !w.archived);
    },
  },
};
