/**
 * P13-R3 §2 — task-scoped broker capability.
 *
 * The master PAIR_BROKER_TOKEN never leaves the server. Before dispatch an
 * executor mints a scoped capability bound to the exact governed context
 * (mission_id + task_id + governed_task_id + executor_id) and integrity-
 * protected by HMAC-SHA256 keyed on the master secret. The remote worker
 * presents only this capability; /api/broker/fetch verifies the signature
 * AND that the claims match both the request body and the canonical task
 * binding before any policy check runs — a capability never expands secret
 * policy or P12 authority.
 *
 * The capability carries no secret value and is never persisted in the
 * PairEvidenceStore.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { utcnow } from "./canonical.js";
import { registerSensitiveMaterial } from "./sanitizer.js";

export interface BrokerCapabilityClaims {
  mission_id: string;
  task_id: string;
  governed_task_id: string | null;
  executor_id: string;
  issued_at: string;
}

const KEY_PREFIX = "pair.broker-capability.v1";

function sign(masterSecret: string, payloadB64: string): string {
  return createHmac("sha256", `${KEY_PREFIX}:${masterSecret}`).update(payloadB64).digest("base64url");
}

export function mintBrokerCapability(
  masterSecret: string,
  claims: {
    mission_id: string;
    task_id: string;
    governed_task_id: string | null;
    executor_id: string;
    issued_at?: string;
  },
): string {
  const payload: BrokerCapabilityClaims = {
    mission_id: String(claims.mission_id),
    task_id: String(claims.task_id),
    governed_task_id: claims.governed_task_id == null ? null : String(claims.governed_task_id),
    executor_id: String(claims.executor_id),
    issued_at: claims.issued_at ?? utcnow(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const token = `bcap1.${payloadB64}.${sign(masterSecret, payloadB64)}`;
  // R4 §1: both the minted capability and the master secret are registered
  // as never-canonical material — a remote worker echoing either sees it
  // redacted before persistence.
  registerSensitiveMaterial(token);
  registerSensitiveMaterial(masterSecret);
  return token;
}

export function verifyBrokerCapability(
  masterSecret: string,
  token: string,
): BrokerCapabilityClaims | null {
  const m = /^bcap1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  const expected = sign(masterSecret, m[1]);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(m[2], "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    typeof claims.mission_id !== "string" ||
    typeof claims.task_id !== "string" ||
    typeof claims.executor_id !== "string" ||
    (claims.governed_task_id !== null && typeof claims.governed_task_id !== "string")
  ) {
    return null;
  }
  return {
    mission_id: claims.mission_id,
    task_id: claims.task_id,
    governed_task_id: (claims.governed_task_id as string | null) ?? null,
    executor_id: claims.executor_id,
    issued_at: String(claims.issued_at ?? ""),
  };
}
