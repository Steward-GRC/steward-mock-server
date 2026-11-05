// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What a client's own tests import to run the mock in-process: start it on a free port, or call
// `handle` with a Request and no port at all, and put the data back between cases.

export { WRONG_CODE, WRONG_PASSWORD } from "#core/auth.ts";
export { publish, subscribe } from "#core/events.ts";
export { handle } from "#core/handle.ts";
export { type Product, settings, useProduct } from "#core/product.ts";
export {
  type MockServerOptions,
  type RunningMockServer,
  startMockServer,
} from "#core/server.ts";
export { endSessions, mockState, resetData, startFresh } from "#core/state.ts";
