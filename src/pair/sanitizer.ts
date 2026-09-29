/**
 * P13-R4 §1 — untrusted remote-output sanitizer.
 *
 * Remote workers are not trusted: any text they return may echo material it
 * was never meant to persist — the task-scoped broker capability, the broker
 * master token, or a credential value released through the broker. Before
 * remote material becomes canonical (`executor_execution.result`,
 * `last_observation`, evidence, events) it passes through this boundary:
 *   bcap1.<payload>.<sig>           → [REDACTED:BROKER_CAPABILITY]
 *   any registered sensitive value  → [REDACTED:SECRET_MATERIAL]
 * Redaction preserves the rest of the worker output; the redaction audit
 * carries only counts, never the value.
 *
 * Defense-in-depth: PairEvidenceStore.assertSecretFree also hard-fails any
 * raw bcap1.* string that still reaches canonical persistence.
 */
export const BROKER_CAPABILITY_SOURCE = "bcap1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+";
export const BROKER_CAPABILITY_PATTERN = new RegExp(BROKER_CAPABILITY_SOURCE, "g");
export const REDACTED_CAPABILITY = "[REDACTED:BROKER_CAPABILITY]";
export const REDACTED_SECRET = "[REDACTED:SECRET_MATERIAL]";

/** Runtime registry of values that must never enter canonical state —
 *  broker-released credential values, the broker master secret, minted
 *  capabilities. Values are only ever compared, never logged or stored. */
const sensitiveMaterials = new Set<string>();

export function registerSensitiveMaterial(value: unknown): void {
  const s = typeof value === "string" ? value : "";
  if (s.length >= 8) sensitiveMaterials.add(s);
}

export interface SanitizeResult {
  value: unknown;
  capability_redactions: number;
  secret_redactions: number;
}

export function sanitizeUntrustedRemote(input: unknown): SanitizeResult {
  const acc = { capability_redactions: 0, secret_redactions: 0 };
  const materials = [...sensitiveMaterials].sort((a, b) => b.length - a.length);
  const value = walk(input, acc, materials);
  return { value, ...acc };
}

function walk(
  v: unknown,
  acc: { capability_redactions: number; secret_redactions: number },
  materials: string[],
): unknown {
  if (typeof v === "string") return scrub(v, acc, materials);
  if (Array.isArray(v)) return v.map((x) => walk(x, acc, materials));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(x, acc, materials);
    }
    return out;
  }
  return v;
}

function scrub(
  s: string,
  acc: { capability_redactions: number; secret_redactions: number },
  materials: string[],
): string {
  if (!s) return s;
  let out = s.replace(BROKER_CAPABILITY_PATTERN, () => {
    acc.capability_redactions += 1;
    return REDACTED_CAPABILITY;
  });
  for (const m of materials) {
    if (out.includes(m)) {
      const parts = out.split(m);
      acc.secret_redactions += parts.length - 1;
      out = parts.join(REDACTED_SECRET);
    }
  }
  return out;
}
