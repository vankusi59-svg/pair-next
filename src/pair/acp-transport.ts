/**
 * ACP stdio transport — TypeScript port of donor acp_client.py (a557df2).
 *
 * One child process speaks newline-delimited JSON-RPC over stdio. Only the
 * stable v1 surface is implemented: initialize / session/new /
 * session/prompt / session/cancel / session/load / session/resume /
 * session/list / session/close / session/set_mode / session/set_config_option.
 * Agent→client requests handled: session/request_permission (routed to the
 * PAIR permission broker) and session/update notifications.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { IntegrityError } from "./errors.js";

export const FROZEN_ACP_PROTOCOL_VERSION = 1;

export interface AcpLaunch {
  command: string;
  args: string[];
  /** Extra env pins — ONLY these are overlaid onto the minimal child env. */
  env?: Record<string, string>;
  evidence?: Record<string, unknown>;
}

type Pending = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export function sessionFeatures(init: Record<string, unknown> | null): Record<string, unknown> {
  const data = init ?? {};
  const caps = (data.agentCapabilities ?? data.agent_capabilities ?? {}) as Record<string, unknown>;
  const sess = (caps.sessionCapabilities ?? caps.session_capabilities ?? {}) as Record<string, unknown>;
  const mcp = (caps.mcpCapabilities ?? caps.mcp_capabilities ?? {}) as Record<string, unknown>;
  const prompt = (caps.promptCapabilities ?? caps.prompt_capabilities ?? {}) as Record<string, unknown>;
  return {
    load_session: Boolean(caps.loadSession ?? caps.load_session),
    resume_session: sess.resume != null,
    list_sessions: sess.list != null,
    close_session: sess.close != null,
    fork_session: sess.fork != null,
    delete_session: sess.delete != null,
    additional_directories: Boolean(sess.additionalDirectories ?? sess.additional_directories),
    mcp_http: Boolean(mcp.http),
    mcp_sse: Boolean(mcp.sse),
    mcp_acp: Boolean(mcp.acp),
    prompt_image: Boolean(prompt.image),
    prompt_audio: Boolean(prompt.audio),
    prompt_embedded_context: Boolean(prompt.embeddedContext ?? prompt.embedded_context),
    agent_info: data.agentInfo ?? data.agent_info,
    auth_methods: data.authMethods ?? data.auth_methods ?? [],
    raw_capabilities: caps,
  };
}

/** `load` | `resume` | null — never emulate a resume the agent did not advertise. */
export function resumeMechanism(features: Record<string, unknown>): "load" | "resume" | null {
  if (features.resume_session) return "resume";
  if (features.load_session) return "load";
  return null;
}

export class AcpProcess {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private permissionHandler:
    | ((sessionId: string, toolCall: Record<string, unknown>, options: Array<Record<string, unknown>>, meta: Record<string, unknown>) => Record<string, unknown>)
    | null = null;
  private updateHandler:
    | ((sessionId: string, update: Record<string, unknown>) => void)
    | null = null;
  private spawnError: Error | null = null;
  private spawnReady: Promise<void> | null = null;

  constructor(
    readonly launch: AcpLaunch,
    private readonly envExtra: Record<string, string> = {},
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get processAlive(): boolean {
    return this.child != null && this.child.exitCode === null && !this.child.killed;
  }

  /** Minimal governed child env — never the full process environment. */
  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "NODE_PATH"]) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
    for (const [k, v] of Object.entries(this.launch.env ?? {})) env[k] = String(v);
    for (const [k, v] of Object.entries(this.envExtra)) env[k] = String(v);
    return env;
  }

  start(
    permissionHandler: AcpProcess["permissionHandler"],
    updateHandler: AcpProcess["updateHandler"] = null,
  ): Promise<void> {
    this.permissionHandler = permissionHandler;
    this.updateHandler = updateHandler;
    this.spawnReady = new Promise<void>((resolve, reject) => {
      try {
        this.child = spawn(this.launch.command, this.launch.args ?? [], {
          env: this.childEnv(),
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        this.spawnError = error as Error;
        reject(new IntegrityError("ACP_SPAWN_FAILED", String(error)));
        return;
      }
      this.child.on("error", (e) => {
        this.spawnError = e;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new IntegrityError("ACP_PROCESS_ERROR", e.message));
        }
        this.pending.clear();
        reject(new IntegrityError("ACP_SPAWN_FAILED", e.message));
      });
      this.child.stderr?.on("data", () => undefined); // stderr never canonical
      const rl = createInterface({ input: this.child.stdout! });
      rl.on("line", (line) => this.handleLine(line));
      this.child.on("exit", (code) => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new IntegrityError("ACP_PROCESS_EXITED", String(code)));
        }
        this.pending.clear();
      });
      resolve();
    });
    return this.spawnReady;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // non-JSON chatter is never canonical
    }
    const id = msg.id;
    if (id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(Number(id));
      if (p) {
        this.pending.delete(Number(id));
        clearTimeout(p.timer);
        if (msg.error !== undefined) {
          const err = msg.error as Record<string, unknown>;
          p.reject(new IntegrityError("ACP_REQUEST_ERROR", String(err.message ?? err.code)));
        } else {
          p.resolve((msg.result ?? {}) as Record<string, unknown>);
        }
      }
      return;
    }
    const method = String(msg.method ?? "");
    if (id != null && method === "session/request_permission") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const sessionId = String(params.sessionId ?? params.session_id ?? "");
      const toolCall = (params.toolCall ?? params.tool_call ?? {}) as Record<string, unknown>;
      const options = (params.options ?? []) as Array<Record<string, unknown>>;
      const outcome = this.permissionHandler
        ? this.permissionHandler(sessionId, toolCall, options, params)
        : { outcome: { outcome: "cancelled" } };
      this.send({ jsonrpc: "2.0", id, result: outcome });
      return;
    }
    if (method === "session/update") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const sessionId = String(params.sessionId ?? params.session_id ?? "");
      this.updateHandler?.(sessionId, (params.update ?? {}) as Record<string, unknown>);
    }
  }

  private send(msg: Record<string, unknown>): void {
    this.child?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeout: number,
  ): Promise<Record<string, unknown>> {
    if (!this.child || !this.child.stdin) {
      return Promise.reject(new IntegrityError("ACP_TRANSPORT_NOT_STARTED", method));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new IntegrityError("ACP_REQUEST_TIMEOUT", method));
        },
        Math.max(1, timeout) * 1000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(timeout = 30, clientVersion = "0.20.0"): Promise<Record<string, unknown>> {
    const resp = await this.request(
      "initialize",
      {
        protocolVersion: FROZEN_ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "pair-os", version: clientVersion },
      },
      timeout,
    );
    const negotiated = resp.protocolVersion ?? resp.protocol_version;
    if (negotiated !== FROZEN_ACP_PROTOCOL_VERSION) {
      throw new IntegrityError("ACP_PROTOCOL_VERSION_MISMATCH", String(negotiated));
    }
    return resp;
  }

  newSession(cwd: string, timeout = 60): Promise<Record<string, unknown>> {
    return this.request("session/new", { cwd, mcpServers: [] }, timeout);
  }

  setSessionMode(sessionId: string, modeId: string, forbidden: Set<string> = new Set(), timeout = 30) {
    if (forbidden.has(modeId)) {
      throw new IntegrityError("ACP_AGENT_MODE_FORBIDDEN", modeId);
    }
    return this.request("session/set_mode", { sessionId, modeId }, timeout);
  }

  setConfigOption(sessionId: string, configId: string, value: string, timeout = 30) {
    return this.request(
      "session/set_config_option",
      { sessionId, configId, value },
      timeout,
    );
  }

  loadSession(cwd: string, sessionId: string, timeout = 60) {
    return this.request("session/load", { cwd, sessionId, mcpServers: [] }, timeout);
  }

  resumeSession(cwd: string, sessionId: string, timeout = 60) {
    return this.request(
      "session/resume",
      { sessionId, cwd, additionalDirectories: null, mcpServers: null },
      timeout,
    );
  }

  listSessions(cwd?: string, timeout = 30) {
    return this.request("session/list", cwd ? { cwd } : {}, timeout);
  }

  closeSession(sessionId: string, timeout = 30) {
    return this.request("session/close", { sessionId }, timeout);
  }

  prompt(sessionId: string, text: string, timeout: number) {
    return this.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      timeout,
    );
  }

  cancelSession(sessionId: string, timeout = 15) {
    return this.request("session/cancel", { sessionId }, timeout);
  }

  /** Terminate the child; never throws. */
  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new IntegrityError("ACP_TRANSPORT_CLOSED", "transport closed"));
    }
    this.pending.clear();
    try {
      this.child?.stdin?.end();
    } catch {
      /* noop */
    }
    try {
      if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
    } catch {
      /* noop */
    }
    const child = this.child;
    if (child) {
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }, 3000).unref();
    }
    this.child = null;
  }
}
