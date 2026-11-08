// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// Live co-editing inside an appendix: it has a room and a token of its own, away from the policy's
// draft. Whoever may edit the policy may join; a checkpoint becomes the appendix's draft content
// and never touches what readers see until the appendix is published.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { WebSocket } from "ws";

import type { RunningMockServer } from "#core/server.ts";

import { stewardData } from "#product/data.ts";
import {
  query,
  type Signed,
  signIn,
  startForTests,
  startFresh,
} from "#product/test-client.ts";

let base = "";
let server: RunningMockServer;
before(async () => {
  ({ base, server } = await startForTests());
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  startFresh();
});

const TOKEN = `mutation ($appendixId: ID!) {
  issueAppendixCollabToken(appendixId: $appendixId) { token wsUrl expiresAt }
}`;

const ask = async (
  signed: Signed,
  text: string,
  variables: Record<string, unknown> = {},
) => {
  const { body } = await query(base, text, signed, variables);
  const error = body.errors?.[0] as
    | { extensions: { code: string }; message: string }
    | undefined;
  return {
    code: error?.extensions.code,
    data: body.data ?? {},
    message: error?.message,
  };
};

// POL-EXPENSES-000002's seeded appendix A, "Per-diem rates".
const APPENDIX = "appendix-1";

const connect = (path: string, cookie: string) =>
  new Promise<{ socket: WebSocket; status?: number }>((resolve, reject) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}${path}`, {
      headers: { cookie },
    });
    socket.once("open", () => resolve({ socket }));
    socket.once("unexpected-response", (_request, response) =>
      resolve({ socket, status: response.statusCode }),
    );
    socket.once("error", (error) => {
      if (!String(error).includes("Unexpected server response")) reject(error);
    });
  });

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
const checkpoint = (content: string) => {
  const text = [...Buffer.from(content, "utf8")];
  return Buffer.from([100, ...variableUint(text.length), ...text, 0]);
};
const controlOf = (frame: Buffer) => {
  assert.equal(frame[0], 101);
  let at = 1;
  let length = 0;
  let shift = 0;
  for (;;) {
    const byte = frame[at++] as number;
    length |= (byte & 127) << shift;
    if (byte < 128) break;
    shift += 7;
  }
  return JSON.parse(frame.subarray(at, at + length).toString("utf8")) as {
    reason?: string;
    type: string;
  };
};
const nextMessage = (socket: WebSocket) =>
  new Promise<Buffer>((resolve) =>
    socket.once("message", (data) => resolve(Buffer.from(data as Buffer))),
  );

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

const join = async (user: string, appendixId = APPENDIX) => {
  const signed = await signIn(base, user);
  const answer = await ask(signed, TOKEN, { appendixId });
  assert.equal(answer.code, undefined, answer.message);
  const issued = answer.data.issueAppendixCollabToken as {
    token: string;
    wsUrl: string;
  };
  const opened = await connect(
    `${issued.wsUrl}?token=${encodeURIComponent(issued.token)}`,
    signed.cookie,
  );
  assert.equal(opened.status, undefined);
  return { issued, socket: opened.socket };
};

describe("an appendix's room and token", () => {
  it("is issued to someone who can edit the policy, for the appendix's own path", async () => {
    const { issued, socket } = await join("bob");
    assert.equal(
      issued.wsUrl,
      `/collab/ws/${encodeURIComponent(`appendix:${APPENDIX}`)}`,
    );
    socket.close();
  });

  it("is refused to a reader, and for an appendix that does not exist", async () => {
    const reader = await signIn(base, "erin");
    assert.equal(
      (await ask(reader, TOKEN, { appendixId: APPENDIX })).code,
      "PermissionDenied",
    );
    const author = await signIn(base, "bob");
    assert.equal(
      (await ask(author, TOKEN, { appendixId: "nope" })).code,
      "NotFound",
    );
  });

  it("is refused for a retired appendix", async () => {
    stewardData().appendices.find((a) => a.id === APPENDIX)!.retiredAt =
      "2026-11-01T00:00:00Z";
    const author = await signIn(base, "bob");
    assert.equal(
      (await ask(author, TOKEN, { appendixId: APPENDIX })).code,
      "FailedPrecondition",
    );
  });

  it("does not open the policy's own room: a token names its own room only", async () => {
    const signed = await signIn(base, "bob");
    const answer = await ask(signed, TOKEN, { appendixId: APPENDIX });
    const issued = answer.data.issueAppendixCollabToken as { token: string };
    const refused = await connect(
      `/collab/ws/version-2?token=${encodeURIComponent(issued.token)}`,
      signed.cookie,
    );
    assert.equal(refused.status, 401);
  });
});

describe("an appendix checkpoint", () => {
  it("becomes the appendix's draft and leaves the published row alone", async () => {
    const { socket } = await join("bob");
    const answer = nextMessage(socket);
    socket.send(checkpoint(document("Written in the room")));
    assert.deepEqual(controlOf(await answer), { type: "snapshot.accepted" });
    const appendix = stewardData().appendices.find((a) => a.id === APPENDIX)!;
    const draft = appendix.versions.find((v) => v.state === "DRAFT");
    assert.equal(draft?.contentJson, document("Written in the room"));
    assert.equal(draft?.title, "Per-diem rates");
    assert.equal(
      appendix.versions.find((v) => v.state === "PUBLISHED")?.title,
      "Per-diem rates",
    );
    assert.notEqual(
      appendix.versions.find((v) => v.state === "PUBLISHED")?.contentJson,
      document("Written in the room"),
    );
    socket.close();
  });

  it("updates the draft that is already there, rather than adding another", async () => {
    const { socket } = await join("bob");
    for (const words of ["First", "Second"]) {
      const answer = nextMessage(socket);
      socket.send(checkpoint(document(words)));
      await answer;
    }
    const appendix = stewardData().appendices.find((a) => a.id === APPENDIX)!;
    assert.equal(
      appendix.versions.filter((v) => v.state === "DRAFT").length,
      1,
    );
    assert.equal(
      appendix.versions.find((v) => v.state === "DRAFT")?.contentJson,
      document("Second"),
    );
    socket.close();
  });

  it("is refused when the content is not a JSON document", async () => {
    const { socket } = await join("bob");
    const answer = nextMessage(socket);
    socket.send(checkpoint("not json"));
    assert.equal(controlOf(await answer).type, "snapshot.rejected");
    socket.close();
  });
});
