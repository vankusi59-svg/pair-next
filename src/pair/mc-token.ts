/**
 * mc-token — canonical Mission Control bearer-token resolution (Phase A /
 * Objective D).
 *
 * ONE resolution point for every component that needs the MC token (server,
 * Telegram bridge, ops scripts). Precedence:
 *
 *   1. explicit `PAIR_MC_TOKEN` env (operator intent — used verbatim)
 *   2. persistent file `$PAIR_HOME/pair-mc-token` (falls back to os.homedir())
 *   3. absent → generate a 256-bit random token, persist chmod 600, reuse
 *
 * Invariants: the token never enters canonical entities/events/evidence,
 * never logs, and is never generated as a known static default (`123`,
 * `pair-mc-test-token`). Empty/whitespace values fail closed.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IntegrityError } from "./errors.js";

export const MC_TOKEN_ENV = "PAIR_MC_TOKEN";
export const MC_TOKEN_FILE_NAME = "pair-mc-token";

/** Values that must never be auto-produced or persisted as a default. */
export const KNOWN_STATIC_TOKENS = new Set(["123", "pair-mc-test-token"]);

type EnvLike = Record<string, string | undefined>;

export interface ResolvedMcToken {
  token: string;
  source: "env" | "file" | "generated";
  /** Persistent file path — safe to log (never the token itself). */
  path: string;
}

function tokenFilePath(homeDir?: string): string {
  const home = homeDir ?? process.env.PAIR_HOME ?? os.homedir();
  return path.join(home, MC_TOKEN_FILE_NAME);
}

function assertTokenShape(token: string, origin: string): string {
  if (token.trim() === "" || token !== token.trim()) {
    throw new IntegrityError("FAIL_CLOSED_MC_TOKEN_INVALID", `${origin}: empty or whitespace-padded token`);
  }
  if (KNOWN_STATIC_TOKENS.has(token) && origin !== "env") {
    // A stored/generated file must never be a known static default.
    throw new IntegrityError("FAIL_CLOSED_MC_TOKEN_WEAK", `${origin}: persisted token is a known static default`);
  }
  return token;
}

export function resolveMcToken(
  opts: { env?: EnvLike; homeDir?: string } = {},
): ResolvedMcToken {
  const env = opts.env ?? (process.env as EnvLike);
  const file = tokenFilePath(opts.homeDir);

  const fromEnv = env[MC_TOKEN_ENV];
  if (fromEnv !== undefined) {
    return { token: assertTokenShape(String(fromEnv), "env"), source: "env", path: file };
  }

  if (fs.existsSync(file)) {
    const stored = fs.readFileSync(file, "utf8");
    return { token: assertTokenShape(stored, "file"), source: "file", path: file };
  }

  const generated = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* non-POSIX fs — best effort */
  }
  return { token: generated, source: "generated", path: file };
}
