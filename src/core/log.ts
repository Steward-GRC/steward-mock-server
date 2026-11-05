// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The mock's logger. LOG_LEVEL picks how much (trace, debug, info, warn, error; info by default)
// and LOG_FORMAT how it looks (console for people, json for a collector). Request bodies are
// never logged: they carry passwords and tokens, even invented ones.

type Level = "debug" | "error" | "info" | "trace" | "warn";

const ORDER: Record<Level, number> = {
  debug: 1,
  error: 4,
  info: 2,
  trace: 0,
  warn: 3,
};

const wanted = (): Level => {
  const level = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return level in ORDER ? (level as Level) : "info";
};

const write = (
  level: Level,
  scope: string,
  message: string,
  fields: object = {},
) => {
  if (ORDER[level] < ORDER[wanted()]) return;
  const at = new Date().toISOString();
  const line =
    process.env.LOG_FORMAT === "json"
      ? JSON.stringify({ at, level, message, scope, ...fields })
      : `${at} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${
          Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ""
        }`;
  if (ORDER[level] >= ORDER.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export interface Logger {
  debug: (message: string, fields?: object) => void;
  error: (message: string, fields?: object) => void;
  info: (message: string, fields?: object) => void;
  trace: (message: string, fields?: object) => void;
  warn: (message: string, fields?: object) => void;
}

export const createLogger = (scope: string): Logger => ({
  debug: (message, fields) => write("debug", scope, message, fields),
  error: (message, fields) => write("error", scope, message, fields),
  info: (message, fields) => write("info", scope, message, fields),
  trace: (message, fields) => write("trace", scope, message, fields),
  warn: (message, fields) => write("warn", scope, message, fields),
});
