// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What a category holds: both document types, one of them, or none (a container for child
// categories). The rules steward-core will enforce (steward-core#34), kept in one place so create
// and move agree with the settings mutation.

import type { GraphQLError } from "graphql";

import type { Category } from "#product/data/library.ts";

import { data, refuse } from "#product/resolvers/shared.ts";

type DocumentType = "POLICY" | "PROCEDURE";

const typeWord = (documentType: DocumentType) =>
  documentType === "POLICY" ? "policies" : "procedures";

/** Whether the category takes a document of this type. */
export const accepts = (category: Category, documentType: DocumentType) =>
  category.documentTypes === "BOTH" ||
  (category.documentTypes === "POLICIES" && documentType === "POLICY") ||
  (category.documentTypes === "PROCEDURES" && documentType === "PROCEDURE");

/** The refusal for creating or moving a document the category does not take. */
export const refusesType = (
  category: Category,
  documentType: DocumentType,
): GraphQLError =>
  refuse(
    "FAILED_PRECONDITION",
    category.documentTypes === "NONE"
      ? `CATEGORY_REFUSES_TYPE: ${category.name} only holds other categories. Pick a child category.`
      : `CATEGORY_REFUSES_TYPE: ${category.name} does not hold ${typeWord(documentType)}.`,
  );

/** Policies and procedures in a category now: drafts and published ones, not retired. */
export const documentCounts = (categoryId: string) => {
  const mine = data().policies.filter(
    (p) => p.homeCategoryId === categoryId && p.retiredAt === null,
  );
  return {
    policies: mine.filter((p) => p.documentType === "POLICY").length,
    procedures: mine.filter((p) => p.documentType === "PROCEDURE").length,
  };
};

/** How many documents the category holds that `next` would no longer accept. */
export const stranded = (
  category: Category,
  next: Category["documentTypes"],
) => {
  const counts = documentCounts(category.id);
  const probe = { ...category, documentTypes: next };
  return (
    (accepts(probe, "POLICY") ? 0 : counts.policies) +
    (accepts(probe, "PROCEDURE") ? 0 : counts.procedures)
  );
};
