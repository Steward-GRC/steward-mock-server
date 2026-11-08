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
import type { PolicyLinks } from "#product/data/policies.ts";

import { type Context, type Resolvers } from "#core/graphql.ts";
import { canAuthorIn } from "#product/access.ts";
import { documentCounts, stranded } from "#product/category-types.ts";
import {
  caller,
  data,
  forbidden,
  found,
  isSiteAdmin,
  newId,
  now,
  record,
  refuse,
  siteAdmin,
  withAnyRole,
} from "#product/resolvers/shared.ts";

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
  groupUnits?:
    | { groupId: string; internalQuorum: string; memberUserIds: string[] }[]
    | null;
  id?: null | string;
  name: string;
  pinnedLast?: boolean | null;
  quorum: string;
  rejectOnSlaBreach?: boolean | null;
  slaDays?: null | number;
}

const stagesOf = (input: StageInput[]): WorkflowStage[] =>
  input.map((s) => ({
    approvers: [...s.approvers],
    approversByCategory: (s.approversByCategory ?? []).map((c) => ({
      approverIds: [...c.approverIds],
      categoryId: c.categoryId,
    })),
    groupUnits: (s.groupUnits ?? []).map((g) => ({
      ...g,
      memberUserIds: [...g.memberUserIds],
    })),
    id: s.id ?? newId("workflow-stage"),
    name: s.name,
    pinnedLast: s.pinnedLast ?? false,
    quorum: s.quorum,
    rejectOnSlaBreach: s.rejectOnSlaBreach ?? false,
    slaDays: s.slaDays ?? null,
  }));

const workflowFor = (id: string) =>
  found(
    data().workflowDefs.find((w) => w.id === id && !w.archived),
    "workflow",
  );

/** How many policies link to a library entry. */
const usedBy = (pick: (links: PolicyLinks) => string[], id: string) =>
  Object.values(data().links).filter((l) => pick(l).includes(id)).length;

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
        owners: [],
        parentId,
        reviewCadence: "NONE",
        reviewDate: null,
        rules: [],
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
      const definition: Definition = {
        ...given.input,
        archived: false,
        createdByUserId: person.id,
        id: newId("definition"),
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
      version.status = "published";
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
      record(
        "template.renamed",
        admin,
        librarySubject("template", template.id, template.name),
      );
      return template;
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
      Object.assign(category, {
        ackTriggers: given.ackTriggers,
        exclusionGroupIds: given.exclusionGroupIds ?? null,
        idpGroupIds: given.idpGroupIds ?? null,
        owners: [...given.owners],
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
      Object.assign(definition, given.input);
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
      return data().categories.filter(
        (c) => c.parentId === (given.parentId ?? null),
      );
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
      if (!given.rootId) return data().categories;
      siteAdmin(context);
      return subtreeOf(categoryFor(given.rootId).id);
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
