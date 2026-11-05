// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The gateway's GraphQL endpoint. Every operation runs against the product's own schema
// (src/product/schema.graphql), so a client gets only the fields it asked for, enums and non-null
// hold, and a query the real gateway would refuse is refused here too. Answers the schema can't
// carry are a mock bug, and come back as INTERNAL rather than as data no real server would send.

import {
  buildSchema,
  type DocumentNode,
  execute,
  type ExecutionResult,
  getOperationAST,
  GraphQLError,
  type GraphQLFieldResolver,
  type GraphQLSchema,
  isObjectType,
  Kind,
  type OperationDefinitionNode,
  parse,
  subscribe,
  validate,
} from "graphql";

import { createLogger } from "#core/log.ts";
import { onProductChange, product, settings } from "#core/product.ts";
import {
  mockState,
  type Person,
  personById,
  type Session,
} from "#core/state.ts";

const log = createLogger("graphql");

/** What every resolver gets as its context. */
export interface Context {
  /** The signed-in person, or null for a public operation. */
  person: null | Person;
  session: null | Session;
}

/** The codes errors carry in `extensions.code`, the way the gateway's error presenter sets them. */
export type ErrorCode =
  | "BAD_USER_INPUT"
  | "FORBIDDEN"
  | "GRAPHQL_PARSE_FAILED"
  | "GRAPHQL_VALIDATION_FAILED"
  | "INTERNAL"
  | "NOT_FOUND"
  | "UNAUTHENTICATED";

/** Throw this from a resolver to answer a coded error, as the gateway does. */
export class MockError extends GraphQLError {
  constructor(code: ErrorCode, message: string) {
    super(message, { extensions: { code } });
  }
}

/** The person behind the context, or an UNAUTHENTICATED error. */
export const signedIn = (context: Context): Person => {
  if (!context.person)
    throw new MockError("UNAUTHENTICATED", "Sign in to continue.");
  return context.person;
};

/** The person behind the context if they hold `role`, or a FORBIDDEN error. */
export const withRole = (context: Context, role: string): Person => {
  const person = signedIn(context);
  if (!person.roles.includes(role)) {
    throw new MockError("FORBIDDEN", "You don't have permission to do that.");
  }
  return person;
};

export interface Resolvers {
  [type: string]:
    | FieldResolvers
    | Record<string, SubscriptionField>
    | undefined;
  Subscription?: Record<string, SubscriptionField>;
}

/** A subscription field: `subscribe` returns the events, `resolve` maps each to the field's value. */
export interface SubscriptionField {
  resolve?: GraphQLFieldResolver<unknown, Context>;
  subscribe: GraphQLFieldResolver<unknown, Context>;
}

type FieldResolvers = Record<string, GraphQLFieldResolver<unknown, Context>>;

/** Build the schema from the product's SDL and wire the product's resolvers into it. */
const build = (): GraphQLSchema => {
  const schema = buildSchema([product().schema].flat().join("\n"));
  for (const [typeName, fields] of Object.entries(product().resolvers)) {
    const type = schema.getType(typeName);
    if (!isObjectType(type) || !fields)
      throw new Error(
        `resolvers name ${typeName}, not an object type in the schema`,
      );
    const schemaFields = type.getFields();
    for (const [fieldName, resolver] of Object.entries(fields)) {
      const field = schemaFields[fieldName];
      if (!field)
        throw new Error(
          `resolvers name ${typeName}.${fieldName}, which the schema doesn't have`,
        );
      if (typeof resolver === "function") {
        field.resolve = resolver as GraphQLFieldResolver<unknown, unknown>;
      } else {
        const subscription = resolver as SubscriptionField;
        field.subscribe = subscription.subscribe as GraphQLFieldResolver<
          unknown,
          unknown
        >;
        field.resolve = (subscription.resolve ??
          ((payload) => payload)) as GraphQLFieldResolver<unknown, unknown>;
      }
    }
  }
  return schema;
};

let built: GraphQLSchema | undefined;

/**
 * The executable schema, built on first use: the product's resolvers import this module's helpers,
 * so building it while the modules load would read the resolvers before they exist.
 */
export const schema = (): GraphQLSchema => (built ??= build());

// A new product brings its own schema and resolvers.
onProductChange(() => {
  built = undefined;
});

export interface Operation {
  operationName?: null | string;
  query?: string;
  variables?: null | Record<string, unknown>;
}

const coded = (code: ErrorCode, message: string) => ({
  extensions: { code },
  message,
});

/** Root fields the operation selects, by name. */
const rootFields = (operation: OperationDefinitionNode): string[] =>
  operation.selectionSet.selections.flatMap((selection) =>
    selection.kind === Kind.FIELD ? [selection.name.value] : ["(fragment)"],
  );

const isPublic = (operation: OperationDefinitionNode) =>
  rootFields(operation).every(
    (name) => name === "__typename" || settings().publicFields.includes(name),
  );

/** A parsed, validated operation, or the errors that stop it, with the HTTP status to send. */
export type Prepared =
  | { document: DocumentNode; ok: true; operation: OperationDefinitionNode }
  | { errors: object[]; ok: false; status: number };

export const prepare = (
  input: Operation,
  session: null | Session,
): Prepared => {
  if (!input.query) {
    return {
      errors: [coded("BAD_USER_INPUT", "The request has no query.")],
      ok: false,
      status: 400,
    };
  }
  let document: DocumentNode;
  try {
    document = parse(input.query);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The query doesn't parse.";
    return {
      errors: [coded("GRAPHQL_PARSE_FAILED", message)],
      ok: false,
      status: 422,
    };
  }
  const invalid = validate(schema(), document);
  if (invalid.length > 0) {
    const errors = invalid.map((error) => ({
      ...error.toJSON(),
      extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
    }));
    return { errors, ok: false, status: 422 };
  }
  const operation = getOperationAST(document, input.operationName ?? undefined);
  if (!operation) {
    return {
      errors: [coded("BAD_USER_INPUT", "Name the operation to run.")],
      ok: false,
      status: 422,
    };
  }
  if (!session && !isPublic(operation)) {
    return {
      errors: [coded("UNAUTHENTICATED", "Sign in to continue.")],
      ok: false,
      status: 401,
    };
  }
  return { document, ok: true, operation };
};

export const contextFor = (session: null | Session): Context => ({
  person: session ? (personById(session.personId) ?? null) : null,
  session,
});

/** Errors as the wire carries them: resolvers' coded errors kept, anything else INTERNAL. */
const presented = (
  result: ExecutionResult,
  operationName: string,
): ExecutionResult => {
  if (!result.errors) return result;
  const errors = result.errors.map((error) => {
    if (error.extensions.code) return error;
    log.error("resolver failed", {
      error: error.message,
      operation: operationName,
      path: error.path,
    });
    return new GraphQLError("Something went wrong on our side.", {
      extensions: { code: "INTERNAL" },
      path: error.path,
    });
  });
  return { ...result, errors };
};

/** Run a query or mutation that `prepare` accepted. */
export const run = async (
  prepared: Extract<Prepared, { ok: true }>,
  input: Operation,
  session: null | Session,
): Promise<ExecutionResult> => {
  const result = await execute({
    contextValue: contextFor(session),
    document: prepared.document,
    operationName: input.operationName ?? undefined,
    schema: schema(),
    variableValues: input.variables ?? undefined,
  });
  return presented(result, prepared.operation.name?.value ?? "(anonymous)");
};

/** Start a subscription that `prepare` accepted: a stream of results, or one result with errors. */
export const start = async (
  prepared: Extract<Prepared, { ok: true }>,
  input: Operation,
  session: null | Session,
): Promise<AsyncIterable<ExecutionResult> | ExecutionResult> => {
  const result = await subscribe({
    contextValue: contextFor(session),
    document: prepared.document,
    operationName: input.operationName ?? undefined,
    schema: schema(),
    variableValues: input.variables ?? undefined,
  });
  return Symbol.asyncIterator in result
    ? result
    : presented(result, prepared.operation.name?.value ?? "(anonymous)");
};

/** The fail-next control's failure for this call, if one is armed; using it disarms it. */
export const armedFailure = (): Response | undefined => {
  const failure = mockState.failNext;
  if (!failure) return undefined;
  mockState.failNext = null;
  if (failure.mode === "http")
    return new Response(null, { status: failure.status });
  return Response.json({
    data: null,
    errors: [coded("INTERNAL", "The mock was told to fail this call.")],
  });
};
