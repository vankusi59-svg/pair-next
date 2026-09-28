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
  }

  private load(): Record<string, BrokerCredential> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.vaultPath, "utf8")) as {
        credentials?: Record<string, BrokerCredential>;
      };
      return raw.credentials ?? {};
    } catch {
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
    const creds = this.load();
    creds[name] = {
      name,
      value: String(input.value),
      domains: (input.domains ?? []).map(String),
      kind: String(input.kind ?? "token"),
      updated_at: utcnow(),
    };
    this.save(creds);
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

  /** Remote-facing release. Returns the credential WITH value, or null when
   *  the name is unknown. Every call is audited — granted or denied. */
  release(
    name: string,
    ctx: { mission_id?: string | null; task_id?: string | null },
  ): BrokerCredential | null {
    const cred = this.load()[String(name)] ?? null;
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
