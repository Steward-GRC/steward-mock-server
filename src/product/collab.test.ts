// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The co-editing relay at /collab/ws/<draftId>, over real websockets: the gateway's 401 without
// a session, steward-collab's 401 for a missing or wrong token, and the relay between the
// browsers on one draft.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { WebSocket } from "ws";

import type { RunningMockServer } from "#core/server.ts";

import { collabPeers } from "#product/collab.ts";
import { stewardData } from "#product/data.ts";
import {
  type Signed,
  signIn,
  startForTests,
  startFresh,
} from "#product/test-client.ts";
import { call } from "#product/web-client.ts";

let base = "";
let server: RunningMockServer;
let bob: Signed;

before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(async () => {
  startFresh();
  bob = await signIn(base, "bob");
});

/** y-websocket's sync step 1 with an empty state vector, as a client opens with. */
const SYNC_STEP_1 = Buffer.from([0, 0, 1, 0]);
/** An empty sync step 2: nothing to send, which still marks a lone client synced. */
const EMPTY_SYNC_STEP_2 = Buffer.from([0, 1, 2, 0, 0]);
/** A document update. */
const UPDATE = Buffer.from([0, 2, 3, 1, 2, 3]);
/** y-websocket's query awareness. */
const QUERY_AWARENESS = Buffer.from([3]);
/** steward-collab's checkpoint frame, client to server only. */
const SNAPSHOT = Buffer.from([100, 2, 123, 125, 0]);

/** Mint a co-editing token the way the staff editor does. */
const tokenFor = async (policyId: string, draftId: string) => {
  const answer = await call(base, bob, "IssueCollabToken", {
    draftId,
    policyId,
  });
  assert.equal(answer.refused, undefined);
  const payload = answer.data.issueCollabToken as {
    token: string;
    wsUrl: string;
  };
  assert.equal(payload.wsUrl, `/collab/ws/${draftId}`);
  return payload.token;
};

interface Opened {
  body?: string;
  challenge?: null | string;
  socket: WebSocket;
  status?: number;
  type?: null | string;
}

/** Open the relay: the open socket, or the HTTP answer that refused it. */
const connect = (path: string, cookie?: string) =>
  new Promise<Opened>((resolve, reject) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}${path}`, {
      headers: cookie ? { cookie } : {},
    });
    socket.once("open", () => resolve({ socket }));
    socket.once("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += String(chunk)));
      response.on("end", () =>
        resolve({
          body,
          challenge: response.headers["www-authenticate"] ?? null,
          socket,
          status: response.statusCode,
          type: response.headers["content-type"] ?? null,
        }),
      );
    });
    socket.once("error", (error) => {
      if (!String(error).includes("Unexpected server response")) reject(error);
    });
  });

/** Join a draft's room as bob with a fresh token. */
const join = async (policyId: string, draftId: string) => {
  const token = await tokenFor(policyId, draftId);
  const opened = await connect(
    `/collab/ws/${draftId}?token=${encodeURIComponent(token)}`,
    bob.cookie,
  );
  assert.equal(opened.status, undefined, opened.body);
  return opened.socket;
};

/** Two clients on version-3, the first already asked for its presence by the second's join. */
const pair = async () => {
  const one = await join("policy-2", "version-3");
  const asked = nextMessage(one);
  const two = await join("policy-2", "version-3");
  assert.deepEqual(await asked, QUERY_AWARENESS);
  return [one, two] as const;
};

/** Collect what a socket hears. */
const listen = (socket: WebSocket) => {
  const heard: Buffer[] = [];
  socket.on("message", (data) => heard.push(Buffer.from(data as Buffer)));
  return heard;
};

const nextMessage = (socket: WebSocket) =>
  new Promise<Buffer>((resolve) =>
    socket.once("message", (data) => resolve(Buffer.from(data as Buffer))),
  );

const settle = () => new Promise((done) => setTimeout(done, 50));

const closed = (socket: WebSocket) =>
  new Promise((done) => {
    socket.once("close", done);
    socket.close();
  });

describe("collab relay", () => {
  it("refuses an upgrade without a session, as the gateway's proxy does", async () => {
    const token = await tokenFor("policy-2", "version-3");
    const refused = await connect(`/collab/ws/version-3?token=${token}`);
    assert.equal(refused.status, 401);
    assert.equal(refused.body, "unauthorized");
    assert.equal(refused.type, "text/plain");
  });

  it("refuses a session without a collab token", async () => {
    const refused = await connect("/collab/ws/version-3", bob.cookie);
    assert.equal(refused.status, 401);
    assert.equal(refused.body, "missing collab token");
    assert.match(refused.challenge ?? "", /^Bearer realm="steward.collab"/);
  });

  it("refuses a token it never issued", async () => {
    const refused = await connect(
      "/collab/ws/version-3?token=collab-token-1",
      bob.cookie,
    );
    assert.equal(refused.status, 401);
    assert.equal(refused.body, "invalid token");
  });

  it("refuses a token issued for another draft", async () => {
    const token = await tokenFor("policy-3", "version-4");
    const refused = await connect(
      `/collab/ws/version-3?token=${encodeURIComponent(token)}`,
      bob.cookie,
    );
    assert.equal(refused.status, 401);
    assert.equal(refused.body, "token/path mismatch");
  });

  it("relays between two clients on one draft, both ways", async () => {
    const [one, two] = await pair();
    const toTwo = nextMessage(two);
    one.send(UPDATE);
    assert.deepEqual(await toTwo, UPDATE);
    const toOne = nextMessage(one);
    two.send(Buffer.from([1, 1, 7]));
    assert.deepEqual(await toOne, Buffer.from([1, 1, 7]));
    await Promise.all([closed(one), closed(two)]);
  });

  it("relays to the same draft only, never back to the sender", async () => {
    const [one, two] = await pair();
    const other = await join("policy-3", "version-4");
    const heardByOne = listen(one);
    const heardByOther = listen(other);
    const toTwo = nextMessage(two);
    one.send(UPDATE);
    assert.deepEqual(await toTwo, UPDATE);
    await settle();
    assert.deepEqual(heardByOne, []);
    assert.deepEqual(heardByOther, []);
    await Promise.all([closed(one), closed(two), closed(other)]);
  });

  it("asks the peers for their presence when a client joins", async () => {
    const one = await join("policy-2", "version-3");
    const heardByOne = listen(one);
    const two = await join("policy-2", "version-3");
    const heardByTwo = listen(two);
    await settle();
    assert.deepEqual(heardByOne, [QUERY_AWARENESS]);
    assert.deepEqual(heardByTwo, []);
    await Promise.all([closed(one), closed(two)]);
  });

  it("answers a lone client's sync step 1 so its editor can start", async () => {
    const one = await join("policy-2", "version-3");
    const answer = nextMessage(one);
    one.send(SYNC_STEP_1);
    assert.deepEqual(await answer, EMPTY_SYNC_STEP_2);
    await closed(one);
  });

  it("answers a joiner's sync step 1 with the room's updates, not the peers", async () => {
    const [one, two] = await pair();
    const toTwo = nextMessage(two);
    one.send(UPDATE);
    assert.deepEqual(await toTwo, UPDATE);
    const heardByOne = listen(one);
    const three = await join("policy-2", "version-3");
    const heardByThree = listen(three);
    three.send(SYNC_STEP_1);
    await settle();
    assert.deepEqual(heardByThree, [UPDATE, EMPTY_SYNC_STEP_2]);
    assert.deepEqual(heardByOne, [QUERY_AWARENESS]);
    await Promise.all([closed(one), closed(two), closed(three)]);
  });

  it("keeps steward-collab's checkpoint frames from the peers", async () => {
    const [one, two] = await pair();
    const heardByTwo = listen(two);
    one.send(SNAPSHOT);
    await settle();
    assert.deepEqual(heardByTwo, []);
    await Promise.all([closed(one), closed(two)]);
  });

  it("drops a socket from its room when it closes, and an empty room's updates", async () => {
    const [one, two] = await pair();
    assert.equal(collabPeers("version-3"), 2);
    await closed(two);
    await settle();
    assert.equal(collabPeers("version-3"), 1);
    const answer = nextMessage(one);
    one.send(SYNC_STEP_1);
    assert.deepEqual(await answer, EMPTY_SYNC_STEP_2);
    one.send(UPDATE);
    await closed(one);
    await settle();
    assert.equal(collabPeers("version-3"), 0);
    const fresh = await join("policy-2", "version-3");
    const answered = nextMessage(fresh);
    fresh.send(SYNC_STEP_1);
    assert.deepEqual(await answered, EMPTY_SYNC_STEP_2);
    await closed(fresh);
  });
});

// What steward-collab does with a checkpoint (bug log 197): the content becomes the draft's saved
// content, the Yjs state is kept to start the room from, and the sender is told it was kept.
const variableUint = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 127) {
    bytes.push(128 | (rest & 127));
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
};

/** [variableUint 100] [variableUint8Array contentJSON] [variableUint8Array yjsState]. */
const checkpoint = (content: string, state: number[] = []) => {
  const text = [...Buffer.from(content, "utf8")];
  return Buffer.from([
    100,
    ...variableUint(text.length),
    ...text,
    ...variableUint(state.length),
    ...state,
  ]);
};

/** The control message in a server frame: [variableUint 101] [variableUint8Array JSON]. */
const controlOf = (frame: Buffer) => {
  assert.equal(frame[0], 101);
  let length = 0;
  let shift = 0;
  let at = 1;
  for (;;) {
    const byte = frame[at++] as number;
    length |= (byte & 127) << shift;
    if (byte < 128) break;
    shift += 7;
  }
  return JSON.parse(frame.subarray(at, at + length).toString("utf8")) as {
    detail?: string;
    reason?: string;
    type: string;
  };
};

const document = (words: string) =>
  JSON.stringify({
    root: {
      children: [
        {
          children: [{ text: words, type: "text", version: 1 }],
          type: "paragraph",
          version: 1,
        },
      ],
      type: "root",
      version: 1,
    },
  });

const contentOf = (versionId: string) =>
  stewardData().versions.find((version) => version.id === versionId)
    ?.contentJson;

const claims = (token: string) =>
  JSON.parse(
    Buffer.from(token.split(".", 2)[1] as string, "base64url").toString("utf8"),
  ) as {
    uid: string;
  };

describe("collab checkpoints (bug log 197)", () => {
  // version-6 is policy-5's withdrawn draft: editing it makes it a plain draft again.
  it("saves the checkpoint as the draft's content and says it was kept", async () => {
    const socket = await join("policy-5", "version-6");
    const answer = nextMessage(socket);
    socket.send(checkpoint(document("Written in the room")));
    assert.deepEqual(controlOf(await answer), { type: "snapshot.accepted" });
    assert.equal(contentOf("version-6"), document("Written in the room"));
    assert.equal(
      stewardData().versions.find((v) => v.id === "version-6")?.status,
      "DRAFT",
    );
    await closed(socket);
  });

  it("refuses a checkpoint whose content is not JSON, and changes nothing", async () => {
    const before = contentOf("version-6");
    const socket = await join("policy-5", "version-6");
    const answer = nextMessage(socket);
    socket.send(checkpoint("not json at all"));
    const control = controlOf(await answer);
    assert.equal(control.type, "snapshot.rejected");
    assert.equal(control.reason, "pre_check_failed");
    assert.equal(contentOf("version-6"), before);
    await closed(socket);
  });

  it("refuses a checkpoint for a version that is not an editable draft", async () => {
    // version-3 is in review
    const before = contentOf("version-3");
    const socket = await join("policy-2", "version-3");
    const answer = nextMessage(socket);
    socket.send(checkpoint(document("Too late")));
    const control = controlOf(await answer);
    assert.equal(control.type, "snapshot.rejected");
    assert.equal(control.reason, "server_rejected");
    assert.equal(contentOf("version-3"), before);
    await closed(socket);
  });

  it("starts the next room from the last checkpoint's Yjs state, after everyone left", async () => {
    const first = await join("policy-5", "version-6");
    const kept = nextMessage(first);
    first.send(checkpoint(document("Kept"), [9, 8, 7]));
    assert.equal(controlOf(await kept).type, "snapshot.accepted");
    await closed(first);
    await settle();
    assert.equal(collabPeers("version-6"), 0);

    const second = await join("policy-5", "version-6");
    const heard = listen(second);
    second.send(SYNC_STEP_1);
    await settle();
    // the state as a sync update, then the empty sync step 2 that marks the client synced
    assert.deepEqual(heard, [
      Buffer.from([0, 2, 3, 9, 8, 7]),
      EMPTY_SYNC_STEP_2,
    ]);
    await closed(second);
  });

  it("forgets the checkpoint's state on Start fresh, with the rest of the data", async () => {
    const socket = await join("policy-5", "version-6");
    const kept = nextMessage(socket);
    socket.send(checkpoint(document("Gone"), [1, 2, 3]));
    assert.equal(controlOf(await kept).type, "snapshot.accepted");
    await closed(socket);
    await settle();
    startFresh();
    bob = await signIn(base, "bob");
    const again = await join("policy-5", "version-6");
    const heard = listen(again);
    again.send(SYNC_STEP_1);
    await settle();
    assert.deepEqual(heard, [EMPTY_SYNC_STEP_2]);
    await closed(again);
  });

  it("names each person by their own token, so two logins are two collaborators", async () => {
    const first = claims(await tokenFor("policy-5", "version-6"));
    const again = claims(await tokenFor("policy-5", "version-6"));
    assert.equal(first.uid, again.uid);
    const other = await signIn(base, "alice");
    const answer = await call(base, other, "IssueCollabToken", {
      draftId: "version-6",
      policyId: "policy-5",
    });
    assert.equal(answer.refused, undefined);
    const second = claims(
      (answer.data.issueCollabToken as { token: string }).token,
    );
    assert.notEqual(second.uid, first.uid);
  });
});
