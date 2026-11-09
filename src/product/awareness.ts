// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// What steward-collab does to presence: every awareness state it relays carries a `user` block
// (`uid`, `name`, `color`, `colorIndex`) written from the signed-in identity, whatever the browser
// put there. Clients draw names and cursor colours from it. The relay here forwards frames as
// they come, so this rewrites the block in each awareness frame (y-protocols message type 1).

/** y-websocket's awareness message type (the first byte of the frame). */
export const MESSAGE_AWARENESS = 1;

/** The cursor colours, taken in turn by colorIndex. */
const COLORS = [
  "#E5484D",
  "#0091FF",
  "#30A46C",
  "#F76B15",
  "#8E4EC6",
  "#12A594",
] as const;

export interface BoundIdentity {
  name: string;
  uid: string;
}

const colorIndexOf = (uid: string): number => {
  let hash = 0;
  for (const char of uid) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % COLORS.length;
};

const readVariableUint = (bytes: Uint8Array, at: number): [number, number] => {
  let value = 0;
  let shift = 0;
  let position = at;
  for (;;) {
    if (position >= bytes.length) throw new Error("truncated frame");
    const byte = bytes[position++] as number;
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return [value, position];
    shift += 7;
  }
};

const writeVariableUint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  while (rest > 127) {
    out.push(128 | (rest % 128));
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
};

const writeVariableString = (text: string): number[] => {
  const bytes = [...Buffer.from(text, "utf8")];
  return [...writeVariableUint(bytes.length), ...bytes];
};

/**
 * The frame with each present state's `user` block set from the identity. A frame that is not an
 * awareness frame, or that cannot be read, comes back as it was.
 */
export const bindIdentity = (
  frame: Uint8Array,
  who: BoundIdentity,
): Uint8Array => {
  if (frame[0] !== MESSAGE_AWARENESS) return frame;
  try {
    const [, afterLength] = readVariableUint(frame, 1);
    let at = afterLength;
    let count: number;
    [count, at] = readVariableUint(frame, at);
    const out: number[] = [...writeVariableUint(count)];
    for (let index = 0; index < count; index++) {
      let clientID: number;
      let clock: number;
      let length: number;
      [clientID, at] = readVariableUint(frame, at);
      [clock, at] = readVariableUint(frame, at);
      [length, at] = readVariableUint(frame, at);
      const json = Buffer.from(frame.subarray(at, at + length)).toString(
        "utf8",
      );
      at += length;
      const state = JSON.parse(json) as null | Record<string, unknown>;
      const next =
        state && typeof state === "object"
          ? {
              ...state,
              user: {
                color: COLORS[colorIndexOf(who.uid)],
                colorIndex: colorIndexOf(who.uid),
                name: who.name,
                uid: who.uid,
              },
            }
          : state;
      out.push(
        ...writeVariableUint(clientID),
        ...writeVariableUint(clock),
        ...writeVariableString(JSON.stringify(next)),
      );
    }
    return Uint8Array.from([
      MESSAGE_AWARENESS,
      ...writeVariableUint(out.length),
      ...out,
    ]);
  } catch {
    return frame;
  }
};
