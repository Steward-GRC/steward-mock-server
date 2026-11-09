// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bindIdentity, MESSAGE_AWARENESS } from "#product/awareness.ts";

const variableUint = (value: number) => {
  const out: number[] = [];
  let rest = value;
  while (rest > 127) {
    out.push(128 | (rest % 128));
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
};
interface State {
  activity?: string;
  user: { color: string; colorIndex: number; name: string; uid: string };
}
const frameOf = (states: [number, number, unknown][]) => {
  const body = [
    ...variableUint(states.length),
    ...states.flatMap(([id, clock, state]) => {
      const json = [...Buffer.from(JSON.stringify(state), "utf8")];
      return [
        ...variableUint(id),
        ...variableUint(clock),
        ...variableUint(json.length),
        ...json,
      ];
    }),
  ];
  return Uint8Array.from([
    MESSAGE_AWARENESS,
    ...variableUint(body.length),
    ...body,
  ]);
};
const readStates = (frame: Uint8Array) => {
  let at = 1;
  const read = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = frame[at++] as number;
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
      shift += 7;
    }
  };
  read();
  const count = read();
  return Array.from({ length: count }, () => {
    const id = read();
    const clock = read();
    const length = read();
    const json = Buffer.from(frame.subarray(at, at + length)).toString("utf8");
    at += length;
    return [id, clock, JSON.parse(json)] as [number, number, State];
  });
};

describe("binding a person into an awareness frame", () => {
  it("writes the user block from the identity over what the browser sent", () => {
    const bound = bindIdentity(
      frameOf([[7, 3, { activity: "typing", user: { name: "Owl" } }]]),
      { name: "Bob Author", uid: "user-bob" },
    );
    const [[id, clock, state]] = readStates(bound) as [[number, number, State]];
    assert.equal(id, 7);
    assert.equal(clock, 3);
    assert.equal(state.user.name, "Bob Author");
    assert.equal(state.user.uid, "user-bob");
    assert.match(state.user.color, /^#[0-9A-F]{6}$/);
    assert.equal(typeof state.user.colorIndex, "number");
    assert.equal(state.activity, "typing");
  });

  it("gives the same person the same colour, and keeps a removed state removed", () => {
    const who = { name: "Alice Admin", uid: "user-alice" };
    const a = readStates(bindIdentity(frameOf([[1, 1, {}]]), who))[0]?.[2];
    const b = readStates(bindIdentity(frameOf([[2, 9, {}]]), who))[0]?.[2];
    assert.equal(a?.user.color, b?.user.color);
    assert.equal(
      readStates(bindIdentity(frameOf([[3, 4, null]]), who))[0]?.[2],
      null,
    );
  });

  it("leaves a cut-off awareness frame as it was, rather than waiting on bytes that never come", () => {
    const cut = Uint8Array.from([MESSAGE_AWARENESS, 200]);
    assert.equal(bindIdentity(cut, { name: "x", uid: "y" }), cut);
    const alone = Uint8Array.from([MESSAGE_AWARENESS]);
    assert.equal(bindIdentity(alone, { name: "x", uid: "y" }), alone);
  });

  it("leaves a frame that is not awareness as it was", () => {
    const sync = Uint8Array.from([0, 2, 1, 2]);
    assert.equal(bindIdentity(sync, { name: "x", uid: "y" }), sync);
  });
});
