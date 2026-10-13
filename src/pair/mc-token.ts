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
/** Phase 1 — the SEPARATE operational-status admin credential. ENV-ONLY:
 *  never generated, never persisted to a file, never defaulted — admin
 *  authority must come from explicit operator configuration. Unset →
 *  null (no admin principal can exist; status queries stay scoped). */
export const MC_ADMIN_TOKEN_ENV = "PAIR_MC_ADMIN_TOKEN";

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
    // Existing persisted token: enforce owner-only mode before trusting it —
    // a permissive file must not silently stay permissive (POSIX only;
    // platforms without mode semantics skip enforcement).
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode !== 0o600) {
        try {
          fs.chmodSync(file, 0o600);
        } catch (err) {
          throw new IntegrityError(
            "FAIL_CLOSED_MC_TOKEN_PERMS",
            `cannot enforce 0600 on persisted token file (${String(err).slice(0, 120)})`,
          );
        }
      }
    }
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

/**
 * Resolve the operational-status admin token. Deliberately stricter than
 * the MC token: environment-only (no file persistence, no generation) —
 * a materialized default would silently grant admin to whoever holds it.
 * Returns null when unset; a malformed/known-static configured value
 * fails closed at boot (it is a configured credential, not a fallback).
 * NOTE: the caller MUST verify the resolved value differs from the MC
 * token — the boundary classifier also refuses the equality case.
 */
/** Minimum length for the operational-status admin credential — an
 *  authority-bearing secret must never be trivially guessable. */
export const MC_ADMIN_TOKEN_MIN_LEN = 16;

export function resolveMcAdminToken(
  opts: { env?: EnvLike } = {},
): string | null {
  const env = opts.env ?? (process.env as EnvLike);
  const raw = env[MC_ADMIN_TOKEN_ENV];
  if (raw === undefined) return null;
  const token = String(raw);
  // F4 — fail closed on any weak/malformed value. The token itself is
  // never logged, persisted or echoed — the error names the RULE, not
  // the secret.
  if (
    token.trim() === "" ||
    token !== token.trim() ||
    token.length < MC_ADMIN_TOKEN_MIN_LEN ||
    new Set(token).size < 4 ||
    KNOWN_STATIC_TOKENS.has(token)
  ) {
    throw new IntegrityError(
      "FAIL_CLOSED_MC_ADMIN_TOKEN_INVALID",
      `${MC_ADMIN_TOKEN_ENV}: missing entropy — must be a distinct secret ≥${MC_ADMIN_TOKEN_MIN_LEN} chars`,
    );
  }
  return token;
}
