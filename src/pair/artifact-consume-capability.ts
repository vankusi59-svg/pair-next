/**
 * F2 §12–§14 — consumer-execution-scoped artifact-fetch capability.
 *
 * A remote governed consumer never receives the artifact master secret.
 * At dispatch the executor mints a scoped CONSUME capability bound to the
 * exact governed context — mission_id + consumer task_id + consumer
 * governed_task_id + consumer execution_id + consumer executor_id — plus
 * the digest of the dependency-artifact set pinned on the governed task.
 * Integrity is protected by HMAC-SHA256 keyed on the artifact master
 * secret in a DIFFERENT domain than the upload capability (`acap1`): an
 * upload capability can never read, and a consume capability can never
 * mint authority.
 *
 * The remote worker presents only this capability via
 * `x-artifact-consume-capability`; /api/artifacts/fetch verifies the
 * signature AND that every claim matches CURRENT durable consumer state
 * AND that the requested artifact belongs to the pinned dependency set
 * before returning exact retained bytes.
 *
 * The capability carries no secret value and is never persisted in the
 * PairEvidenceStore.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { digest, utcnow } from "./canonical.js";
import { registerSensitiveMaterial } from "./sanitizer.js";

export interface ArtifactConsumeCapabilityClaims {
  mission_id: string;
  task_id: string;
  governed_task_id: string;
  execution_id: string;
  executor_id: string;
  dependency_set_digest: string;
  issued_at: string;
}

const KEY_PREFIX = "pair.artifact-consume-capability.v1";

function sign(masterSecret: string, payloadB64: string): string {
  return createHmac("sha256", `${KEY_PREFIX}:${masterSecret}`).update(payloadB64).digest("base64url");
}

/**
 * Deterministic digest over the exact dependency-artifact set pinned on
 * the governed consumer task. Every authoritative field of every entry
 * is covered — mutating artifact_id / sha256 / byte_size /
 * producer_execution_id / consumer_relative_path / producer identity
 * after the pin changes this digest and invalidates every capability
 * minted against the original set.
 */
export function artifactDependencySetDigest(
  entries: ReadonlyArray<object>,
): string {
  const norm = (entries as Array<Record<string, unknown>>)
    .map((e) => ({
      artifact_id: String(e.artifact_id ?? ""),
      producer_task_id: String(e.producer_task_id ?? ""),
      producer_governed_task_id: String(e.producer_governed_task_id ?? ""),
      producer_execution_id: String(e.producer_execution_id ?? ""),
      producer_executor_id: String(e.producer_executor_id ?? ""),
      logical_name: String(e.logical_name ?? ""),
      sha256: String(e.sha256 ?? ""),
      byte_size: Number(e.byte_size ?? 0),
      consumer_relative_path: String(e.consumer_relative_path ?? ""),
      contract: String(e.contract ?? ""),
    }))
    .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  return digest({ contract: "pair-artifact-dependency-set.v1", entries: norm });
}

export function mintArtifactConsumeCapability(
  masterSecret: string,
  claims: {
    mission_id: string;
    task_id: string;
    governed_task_id: string;
    execution_id: string;
    executor_id: string;
    dependency_set_digest: string;
    issued_at?: string;
  },
): string {
  const payload: ArtifactConsumeCapabilityClaims = {
    mission_id: String(claims.mission_id),
    task_id: String(claims.task_id),
    governed_task_id: String(claims.governed_task_id),
    execution_id: String(claims.execution_id),
    executor_id: String(claims.executor_id),
    dependency_set_digest: String(claims.dependency_set_digest),
    issued_at: claims.issued_at ?? utcnow(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const token = `acread1.${payloadB64}.${sign(masterSecret, payloadB64)}`;
  registerSensitiveMaterial(token);
  registerSensitiveMaterial(masterSecret);
  return token;
}

export function verifyArtifactConsumeCapability(
  masterSecret: string,
  token: string,
): ArtifactConsumeCapabilityClaims | null {
  const m = /^acread1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
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
    typeof claims.governed_task_id !== "string" ||
    typeof claims.execution_id !== "string" ||
    typeof claims.executor_id !== "string" ||
    typeof claims.dependency_set_digest !== "string"
  ) {
    return null;
  }
  return {
    mission_id: claims.mission_id,
    task_id: claims.task_id,
    governed_task_id: claims.governed_task_id,
    execution_id: claims.execution_id,
    executor_id: claims.executor_id,
    dependency_set_digest: claims.dependency_set_digest,
    issued_at: String(claims.issued_at ?? ""),
  };
}

/** Same master resolution as the upload capability — the DOMAIN
 *  separation lives in the keyed prefix, not the secret. */
export function artifactConsumeCapabilityMasterFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.PAIR_ARTIFACT_UPLOAD_TOKEN || env.PAIR_BROKER_TOKEN || undefined;
}
