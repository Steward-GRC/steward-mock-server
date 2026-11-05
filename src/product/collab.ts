// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The co-editing relay at /collab/ws/<draftId>, where steward-gateway proxies steward-collab
// (internal/collabws). The gateway refuses an upgrade without a session; collab then checks the
// token issueCollabToken minted (signature, audience, expiry, the draft in the path) and relays
// y-websocket frames between the browsers on the draft. Here it's a relay with no Y.Doc of its
// own: every frame goes to the other sockets on the draft, except
//
// - a sync step 1, which the relay answers itself, as collab does from its stored state: the
//   room's document updates so far, then an empty sync step 2. The client counts as synced, and
//   an editor alone in a new room fills itself from the draft. A peer never has to answer, so one
//   that stopped answering (a tab the browser holds in its back/forward cache) can't leave a
//   joiner unsynced.
// - collab's checkpoint frame (type 100), which goes to the server only. The mock doesn't save
//   it: the editor's Save button writes the draft through saveDraft.
//
// And a client joining a room with peers in it makes the relay ask them for their presence, so the
// joiner sees who else is editing at once, as collab's stored presence lets it.
//
// A room and its updates last until its last socket closes. The core has no reset hook, so Reset
// and Start fresh leave open rooms as they are.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";

import type { ProductSockets } from "#core/product.ts";

import { sessionOfCookie } from "#core/auth.ts";

/** steward-collab's token audience (internal/ws TokenAudience). */
const AUDIENCE = "steward.collab.ws";
const CHALLENGE = 'Bearer realm="steward.collab", error="invalid_token"';
const PATH = /^\/collab\/ws\/([^/]+)$/;
/** Signs this process's tokens; a restart refuses the old ones, which the editor re-mints. */
const SECRET = randomBytes(32);

/** y-websocket frame types (the first byte of every frame here). */
const MESSAGE_SYNC = 0;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const MESSAGE_SNAPSHOT = 100;
/** y-websocket's query awareness: the client answers with every presence it knows. */
const QUERY_AWARENESS = Buffer.from([3]);
/** Sync step 2 with an empty update: nothing to add, and the client is synced. */
const EMPTY_SYNC_STEP_2 = Buffer.from([0, 1, 2, 0, 0]);

/** A draft's room: its open sockets, and every document update they sent, in order. */
interface Room {
  sockets: Set<WebSocket>;
  updates: Uint8Array[];
}

/** The rooms, by draft id. */
const rooms = new Map<string, Room>();

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

const sign = (text: string) =>
  createHmac("sha256", SECRET).update(text).digest();

/** The path issueCollabToken hands the editor. */
export const collabPath = (draftId: string): string =>
  `/collab/ws/${encodeURIComponent(draftId)}`;

/** A token shaped like steward-collab's: an HS256 JWT naming the person, policy and draft. */
export const collabToken = (claims: {
  draftId: string;
  expiresAt: Date;
  policyId: string;
  userId: string;
}): string => {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      aud: AUDIENCE,
      did: claims.draftId,
      exp: Math.floor(claims.expiresAt.getTime() / 1000),
      pid: claims.policyId,
      uid: claims.userId,
    }),
  );
  return `${header}.${payload}.${base64url(sign(`${header}.${payload}`))}`;
};

/** The draft a token names, or undefined for one this process didn't sign or that expired. */
const draftOfToken = (token: string): string | undefined => {
  const [header = "", payload = "", signature = ""] = token.split(".");
  const given = Buffer.from(signature, "base64url");
  const wanted = sign(`${header}.${payload}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return;
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as { aud?: string; did?: string; exp?: number };
  if (claims.aud !== AUDIENCE || (claims.exp ?? 0) * 1000 <= Date.now()) return;
  return claims.did;
};

const refuse = (text: string, challenge = false) =>
  new Response(text, {
    headers: {
      "content-type": "text/plain",
      ...(challenge ? { "www-authenticate": CHALLENGE } : {}),
    },
    status: 401,
  });

/** How many sockets are open on a draft. */
export const collabPeers = (draftId: string): number =>
  rooms.get(draftId)?.sockets.size ?? 0;

const join = (draftId: string, socket: WebSocket) => {
  const room = rooms.get(draftId) ?? { sockets: new Set(), updates: [] };
  for (const peer of room.sockets)
    if (peer.readyState === WebSocket.OPEN) peer.send(QUERY_AWARENESS);
  room.sockets.add(socket);
  rooms.set(draftId, room);
  socket.on("message", (data, isBinary) => {
    const frame = Array.isArray(data)
      ? Buffer.concat(data)
      : new Uint8Array(data);
    if (isBinary && frame[0] === MESSAGE_SNAPSHOT) return;
    if (isBinary && frame[0] === MESSAGE_SYNC) {
      if (frame[1] === SYNC_STEP_1) {
        for (const update of room.updates) socket.send(update);
        socket.send(EMPTY_SYNC_STEP_2);
        return;
      }
      if (frame[1] === SYNC_STEP_2 || frame[1] === SYNC_UPDATE)
        room.updates.push(Uint8Array.from(frame));
    }
    for (const peer of room.sockets)
      if (peer !== socket && peer.readyState === WebSocket.OPEN)
        peer.send(data, { binary: isBinary });
  });
  socket.on("close", () => {
    room.sockets.delete(socket);
    if (room.sockets.size === 0 && rooms.get(draftId) === room)
      rooms.delete(draftId);
  });
};

/** /collab/ws/<draftId>: the gateway's session check, then collab's token check. */
export const collabSockets: ProductSockets = (request, path) => {
  const match = PATH.exec(path)?.[1];
  if (!match) return;
  if (!sessionOfCookie(request)) return refuse("unauthorized");
  const draftId = decodeURIComponent(match);
  const url = new URL(request.url);
  const bearer = /^Bearer (.+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  const token = url.searchParams.get("token") || bearer;
  if (!token) return refuse("missing collab token", true);
  let named: string | undefined;
  try {
    named = draftOfToken(token);
  } catch {
    named = undefined;
  }
  if (named === undefined) return refuse("invalid token", true);
  if (named !== draftId) return refuse("token/path mismatch", true);
  return (socket) => join(draftId, socket);
};
