/**
 * P-CRED credential broker — scoped credential release for remote executors.
 *
 * Problem: remote tasks (DEVIN sessions) hit login walls (GitHub, TradingView,
 * service dashboards). Without a broker the mission stalls on
 * REMOTE_INPUT_REQUIRED or the operator pastes a password into a prompt —
 * which lands it in the remote transcript.
 *
 * Design: secrets live in a local vault file (PAIR_MC_DIR/vault.json,
 * chmod 600) — NOT in the canonical entity store, which asserts payloads are
 * secret-free and feeds evidence/event exports. Remote agents fetch a named
 * credential over a dedicated endpoint authenticated by a narrow broker
 * token; every release is recorded as a canonical audit event. The remote
 * prompt carries only the token + fetch instructions, never a value.
 *
 * Scope note (v1): the broker token can release any installed credential —
 * the operator installs only what PAIR missions may use. Per-mission
 * credential allowlists are the next hardening step.
 *
 * Vault schema: { credentials: {name: cred}, retired: [cred...] }.
 * `credentials` are ACTIVE and releasable. `retired` holds rotated/deleted
 * values — never releasable, never listed — kept only so the sanitizer can
 * keep redacting secrets that may still live in an outstanding remote
 * execution after rotate/delete + process restart (R6 §1).
 */
import fs from "node:fs";
import path from "node:path";
import { utcnow } from "./canonical.js";
import { registerSensitiveMaterial } from "./sanitizer.js";

export interface BrokerCredential {
  name: string;
  /** Secret value — NEVER returned by list()/upsert(), only by release(). */
  value: string;
  /** Domains/services this credential is meant for (operator-declared scope). */
  domains: string[];
  /** 'token' | 'basic' | 'header' — how the agent should apply it. */
  kind: string;
  updated_at: string;
}

/** Redaction-only material: a retired value is never returned by release()
 *  or list(). It exists so a stale remote session echoing the old secret is
 *  still sanitized before canonical persistence. */
interface RetiredCredential extends BrokerCredential {
  retired_at: string;
}

interface VaultFile {
  credentials: Record<string, BrokerCredential>;
  retired: RetiredCredential[];
}

export interface BrokerDeps {
  vaultPath: string;
  /** Audit sink — called on every release attempt (success or denial) so
   *  credential usage is traceable to a mission/task. */
  audit?: (evt: {
    event_type: string;
    credential_name: string;
    mission_id: string | null;
    task_id: string | null;
    granted: boolean;
  }) => void;
}

/** R5 §2: minimum credential value length — the sanitizer protection
 *  threshold. The broker enforces it at install AND at load, so an
 *  accepted credential can never fall below non-persistence coverage. */
export const MIN_CREDENTIAL_VALUE_LENGTH = 8;

export class CredentialBroker {
  private readonly vaultPath: string;
  private readonly audit?: BrokerDeps["audit"];

  constructor(deps: BrokerDeps) {
    this.vaultPath = deps.vaultPath;
    this.audit = deps.audit;
    fs.mkdirSync(path.dirname(this.vaultPath), { recursive: true });
    if (!fs.existsSync(this.vaultPath)) {
      fs.writeFileSync(this.vaultPath, JSON.stringify({ credentials: {}, retired: [] }), { mode: 0o600 });
    } else {
      fs.chmodSync(this.vaultPath, 0o600);
    }
    // R5 §1 + R6 §1 restart durability: register every credential ALREADY in
    // the vault — active AND retired — immediately at startup, no
    // release/upsert needed, so a post-restart echo from an old remote
    // session is still redacted. load() validates the vault and the minimum
    // length, so a corrupt/short value fails closed here rather than
    // slipping under sanitizer coverage.
    const vault = this.load();
    for (const cred of Object.values(vault.credentials)) registerSensitiveMaterial(cred.value);
    for (const cred of vault.retired) registerSensitiveMaterial(cred.value);
  }

  /** Fail-closed vault load. A missing vault is created empty by the
   *  constructor; anything else unparsable or malformed aborts startup —
   *  silently converting an invalid vault to {} would leave sanitizer
   *  coverage empty. Error detail carries names only, never values. */
  private load(): VaultFile {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.vaultPath, "utf8"));
    } catch {
      throw new Error("FAIL_CLOSED_CREDENTIAL_VAULT_INVALID");
    }
    const invalid = (key: string): Error => new Error(`FAIL_CLOSED_CREDENTIAL_VAULT_INVALID:${key}`);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("root");
    const credentials = (raw as { credentials?: unknown }).credentials;
    const retired = (raw as { retired?: unknown }).retired ?? [];
    if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
      throw invalid("credentials");
    }
    if (!Array.isArray(retired)) throw invalid("retired");
    const checkCred = (key: string, cred: unknown, needsRetiredAt: boolean): void => {
      if (typeof cred !== "object" || cred === null || Array.isArray(cred)) throw invalid(key);
      const c = cred as Record<string, unknown>;
      if (typeof c.name !== "string" || typeof c.value !== "string" ||
          !Array.isArray(c.domains) || typeof c.kind !== "string" ||
          typeof c.updated_at !== "string") throw invalid(key);
      if (needsRetiredAt && typeof c.retired_at !== "string") throw invalid(key);
      if (c.value.length < MIN_CREDENTIAL_VALUE_LENGTH) {
        throw new Error(`FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT:${key}`);
      }
    };
    for (const [name, cred] of Object.entries(credentials as Record<string, unknown>)) checkCred(name, cred, false);
    for (const [i, cred] of (retired as unknown[]).entries()) checkCred(`retired:${i}`, cred, true);
    return { credentials: credentials as Record<string, BrokerCredential>, retired: retired as RetiredCredential[] };
  }

  private save(vault: VaultFile): void {
    const tmp = this.vaultPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(vault), { mode: 0o600 });
    fs.renameSync(tmp, this.vaultPath);
  }

  /** Operator-facing write. Returns metadata only — the value is never echoed. */
  upsert(input: { name: string; value: string; domains?: string[]; kind?: string }): Omit<BrokerCredential, "value"> {
    const name = String(input.name).trim();
    if (!name || !input.value) throw new Error("credential name and value are required");
    const value = String(input.value);
    if (value.length < MIN_CREDENTIAL_VALUE_LENGTH) {
      throw new Error(`FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT:${name}`);
    }
    const vault = this.load();
    // R6 §1: replacing an existing credential retires its old value into
    // redaction-only material — still sanitized, never releasable again.
    if (name in vault.credentials) {
      vault.retired.push({ ...vault.credentials[name], retired_at: utcnow() });
    }
    vault.credentials[name] = {
      name,
      value,
      domains: (input.domains ?? []).map(String),
      kind: String(input.kind ?? "token"),
      updated_at: utcnow(),
    };
    this.save(vault);
    // R4 §1: vault values are never-canonical material — an echo in remote
    // output is redacted before persistence.
    registerSensitiveMaterial(vault.credentials[name].value);
    const { value: _v, ...meta } = vault.credentials[name];
    return meta;
  }

  /** Names + metadata only — values never leave this listing; retired
   *  entries are never listed either. */
  list(): Array<Omit<BrokerCredential, "value">> {
    return Object.values(this.load().credentials).map(({ value: _v, ...meta }) => meta);
  }

  remove(name: string): boolean {
    const vault = this.load();
    if (!(name in vault.credentials)) return false;
    // R6 §1: deletion retires the value as redaction-only material so an
    // outstanding remote execution echoing it stays sanitized.
    vault.retired.push({ ...vault.credentials[name], retired_at: utcnow() });
    delete vault.credentials[name];
    this.save(vault);
    return true;
  }

  /** Record a denied fetch attempt (e.g. rejected upstream for an unknown
   *  mission) so hostile probing is audited even when release() never runs. */
  deny(name: string, ctx: { mission_id?: string | null; task_id?: string | null }): void {
    this.audit?.({
      event_type: "CREDENTIAL_DENIED",
      credential_name: String(name),
      mission_id: ctx.mission_id ?? null,
      task_id: ctx.task_id ?? null,
      granted: false,
    });
  }

  /** Remote-facing release. Returns the credential WITH value, or null when
   *  the name is unknown. Only ACTIVE credentials can ever be released —
   *  retired values are unreachable. Every call is audited. */
  release(
    name: string,
    ctx: { mission_id?: string | null; task_id?: string | null },
  ): BrokerCredential | null {
    const cred = this.load().credentials[String(name)] ?? null;
    if (cred) registerSensitiveMaterial(cred.value);
    this.audit?.({
      event_type: cred ? "CREDENTIAL_RELEASED" : "CREDENTIAL_DENIED",
      credential_name: String(name),
      mission_id: ctx.mission_id ?? null,
      task_id: ctx.task_id ?? null,
      granted: !!cred,
    });
    return cred;
  }
}
