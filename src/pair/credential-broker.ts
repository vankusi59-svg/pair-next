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
      fs.writeFileSync(this.vaultPath, JSON.stringify({ credentials: {} }), { mode: 0o600 });
    } else {
      fs.chmodSync(this.vaultPath, 0o600);
    }
    // R5 §1 restart durability: register every credential ALREADY in the
    // vault immediately at startup — no release/upsert needed — so a
    // post-restart echo from an old remote session is still redacted.
    // load() validates the minimum length, so a legacy short value fails
    // closed here rather than slipping under sanitizer coverage.
    for (const cred of Object.values(this.load())) {
      registerSensitiveMaterial(cred.value);
    }
  }

  private load(): Record<string, BrokerCredential> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.vaultPath, "utf8")) as {
        credentials?: Record<string, BrokerCredential>;
      };
      const creds = raw.credentials ?? {};
      for (const [name, cred] of Object.entries(creds)) {
        if (typeof cred.value !== "string" || cred.value.length < MIN_CREDENTIAL_VALUE_LENGTH) {
          throw new Error(`FAIL_CLOSED_CREDENTIAL_VALUE_TOO_SHORT:${name}`);
        }
      }
      return creds;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("FAIL_CLOSED_")) throw e;
      return {};
    }
  }

  private save(creds: Record<string, BrokerCredential>): void {
    const tmp = this.vaultPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ credentials: creds }), { mode: 0o600 });
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
    const creds = this.load();
    creds[name] = {
      name,
      value: String(input.value),
      domains: (input.domains ?? []).map(String),
      kind: String(input.kind ?? "token"),
      updated_at: utcnow(),
    };
    this.save(creds);
    // R4 §1: vault values are never-canonical material — an echo in remote
    // output is redacted before persistence.
    registerSensitiveMaterial(creds[name].value);
    const { value: _v, ...meta } = creds[name];
    return meta;
  }

  /** Names + metadata only — values never leave this listing. */
  list(): Array<Omit<BrokerCredential, "value">> {
    return Object.values(this.load()).map(({ value: _v, ...meta }) => meta);
  }

  remove(name: string): boolean {
    const creds = this.load();
    if (!(name in creds)) return false;
    delete creds[name];
    this.save(creds);
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
   *  the name is unknown. Every call is audited — granted or denied. */
  release(
    name: string,
    ctx: { mission_id?: string | null; task_id?: string | null },
  ): BrokerCredential | null {
    const cred = this.load()[String(name)] ?? null;
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
