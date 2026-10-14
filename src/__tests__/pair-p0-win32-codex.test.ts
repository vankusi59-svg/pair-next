/**
 * P0 — Windows-native runtime closure, Workstream B.
 *
 *   A  native executable resolution — PATHEXT/`.exe` preference, the
 *      `%LOCALAPPDATA%\OpenAI\Codex\bin\<ver>\codex.exe` install-root
 *      fallback, the executor lane's PAIR_CODEX_EXECUTABLE seam, and
 *      windowsSpawnTarget's COMSPEC wrapping contract (safe `.cmd`
 *      launch with a strict argv whitelist; metacharacters fail closed).
 *   B  executor lifecycle on this host — dispatch → governed artifact →
 *      COMPLETED via the fake-codex fixture; async spawn errors settle
 *      FAILED instead of hanging; timeout and cancellation settle.
 *   C  REAL codex-cli on the Windows host (live-gated) — the governed
 *      task runs under `windows.sandbox='elevated'` as the restricted
 *      CodexSandboxOffline principal, writes an authorized workspace
 *      artifact, and the canonical artifact path ingests it to
 *      ACCEPTED. A red control run without the sandbox pin proves the
 *      governed shell boundary still rejects tool execution.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

/* B4 drives the ASYNC child 'error' path (post-spawn ENOENT/EACCES —
 * the win32 failure shape Node delivers via the event, not a sync
 * throw). spawn is wrapped module-wide but delegates to the real
 * implementation unless the flag is armed for that one test. */
const spawnErr = vi.hoisted(() => ({ armed: false }));
vi.mock("node:child_process", async () => {
  const real = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>(
    "node:events",
  );
  const { PassThrough } = await vi.importActual<typeof import("node:stream")>(
    "node:stream",
  );
  return {
    ...real,
    spawn: ((...a: Parameters<typeof real.spawn>) => {
      if (!spawnErr.armed) return real.spawn(...a);
      const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
      c.stdin = new PassThrough();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.pid = 4242;
      c.kill = () => true;
      setImmediate(() => c.emit("error", new Error("ENOENT async")));
      return c as unknown as ReturnType<typeof real.spawn>;
    }) as typeof real.spawn,
  };
});

import {
  CodexCliExecutorAdapter,
  CODEX_EXECUTOR_ID,
} from "../pair/codex-adapter.js";
import {
  resolveCodexExecutable,
  resolveCodexExecutableSystem,
  windowsSpawnTarget,
} from "../pair/codex-cli-transport.js";
import {
  codexRunRoot,
  PairControlPlane,
  PairEvidenceStore,
  sha256Hex,
  utcnow,
} from "../pair/index.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-p0-codex-"));
const isWin32 = process.platform === "win32";
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const FAKE_ARGV_CODEX = path.resolve(__dirname, "fixtures", "fake-codex-argv.mjs");

function makeAdapter(dir: string, envMap: Record<string, string | undefined> = {}) {
  return new CodexCliExecutorAdapter({
    journalRoot: path.join(dir, "journal"),
    executable: "node",
    executableArgs: [FAKE_ARGV_CODEX],
    envReader: (nm: string) => (nm in envMap ? envMap[nm] : process.env[nm]),
  });
}

function makeTask(
  dir: string,
  gtid: string,
  permissions: string[] = ["FILE_WRITE"],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const ws = path.join(dir, `ws-${gtid}`);
  fs.mkdirSync(ws, { recursive: true });
  return {
    governed_task_id: gtid,
    mission_id: "MSN_P0",
    task_id: `task_${gtid}`,
    workspace: ws,
    allowed_paths: [ws],
    permissions,
    correlation_id: `corr-${gtid}`,
    governance_digest: "x",
    executor_id: CODEX_EXECUTOR_ID,
    governance_state: "DISPATCH_AUTHORIZED",
    dispatch_enabled: true,
    timeout: 30,
    task_instruction: "write codex_out.txt then DONE",
    constraints: [],
    ...overrides,
  };
}

async function waitTerminal(
  adapter: CodexCliExecutorAdapter,
  executionId: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const o = adapter.observe(executionId);
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "UNKNOWN"].includes(String(o.status))) {
      return o;
    }
    if (Date.now() > deadline) throw new Error(`execution ${executionId} never terminal`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

const val = (argv: string[], flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
};

/* ==================== A — Windows executable resolution ==================== */

describe("A — native Windows codex executable resolution", () => {
  it("A1 PATH/PATHEXT prefers a real .exe over the npm .cmd shim", () => {
    if (!isWin32) return;
    const resolved = resolveCodexExecutableSystem(undefined);
    expect(resolved).not.toBeNull();
    // On this host PATH exposes only codex.cmd — the install-root scan
    // must still land on a real PE image.
    expect(String(resolved).toLowerCase()).toMatch(/codex\.(exe|com)$/);
    expect(fs.existsSync(String(resolved))).toBe(true);
    expect(fs.statSync(String(resolved)).isFile()).toBe(true);
  });

  it("A2 PAIR_CODEX_EXECUTABLE seam + .cmd shim launches via COMSPEC (win32)", async () => {
    const d = dir("a2");
    const task = makeTask(d, "GTSK_A2");
    if (isWin32) {
      // A .cmd shim driving the fixture: proves the env seam resolves
      // AND the COMSPEC wrapper launches batch launchers with the real
      // governed argv intact.
      const shim = path.join(d, "codex-shim.cmd");
      fs.writeFileSync(
        shim,
        `@echo off\r\n"${process.execPath}" "${FAKE_ARGV_CODEX}" %*\r\n`,
      );
      const adapter = new CodexCliExecutorAdapter({
        journalRoot: path.join(d, "journal"),
        envReader: (nm: string) =>
          nm === "PAIR_CODEX_EXECUTABLE" ? shim
          : nm === "OPENAI_API_KEY" ? "test-key"
          : process.env[nm],
      });
      const rec = adapter.dispatch(task);
      const o = await waitTerminal(adapter, String(rec.execution_id), 15_000);
      expect(o.status).toBe("COMPLETED");
      expect(fs.existsSync(path.join(String(task.workspace), "codex_out.txt"))).toBe(true);
      const final = JSON.parse(fs.readFileSync(
        path.join(codexRunRoot(path.join(d, "journal"), String(rec.execution_id)), "final.json"),
        "utf8",
      ));
      const argv = final.argv as string[];
      // The governed argv survived cmd /d /s /c re-parsing intact.
      expect(val(argv, "--config")).toContain("windows.sandbox='elevated'");
      expect(argv[0]).toBe("exec");
    } else {
      // POSIX: env seam still resolves; a missing file fails closed at
      // qualification — dispatch throws, no process is ever spawned.
      const bogus = path.join(d, "env-provided-codex");
      const adapter = new CodexCliExecutorAdapter({
        journalRoot: path.join(d, "journal"),
        envReader: (nm: string) =>
          nm === "PAIR_CODEX_EXECUTABLE" ? bogus
          : nm === "OPENAI_API_KEY" ? "test-key"
          : process.env[nm],
      });
      expect(() => adapter.dispatch(task)).toThrow(
        /FAIL_CLOSED_EXECUTOR_UNQUALIFIED/);
    }
  });

  it("A3 planner seam precedence: PLANNER_EXECUTABLE > EXECUTABLE > scan", () => {
    const envFn = (m: Record<string, string>) => (nm: string) => m[nm];
    expect(resolveCodexExecutable(envFn({
      PAIR_CODEX_PLANNER_EXECUTABLE: "P.exe",
      PAIR_CODEX_EXECUTABLE: "E.exe",
    }))).toBe("P.exe");
    expect(resolveCodexExecutable(envFn({ PAIR_CODEX_EXECUTABLE: "E.exe" }))).toBe("E.exe");
  });

  it("A4 windowsSpawnTarget: .exe passthrough, .cmd wrapped via COMSPEC, metacharacters rejected", () => {
    if (!isWin32) return;
    expect(windowsSpawnTarget("C:\\x\\codex.exe", ["exec"]))
      .toEqual({ command: "C:\\x\\codex.exe", args: ["exec"] });
    const wrapped = windowsSpawnTarget("C:\\x\\codex.cmd", ["exec", "--json"]);
    expect(wrapped).not.toBeNull();
    expect(String(wrapped!.command).toLowerCase()).toContain("cmd.exe");
    expect(wrapped!.args.slice(0, 4)).toEqual(["/d", "/s", "/c", "C:\\x\\codex.cmd"]);
    // cmd metacharacters never reach the command line — fail closed.
    for (const bad of ["a&b", "a|b", "a%b", 'a"b', "a^b", "a\nb"]) {
      expect(windowsSpawnTarget("C:\\x\\codex.cmd", ["exec", bad])).toBeNull();
    }
    // The REAL argv grammar the adapter emits (single-quoted TOML
    // literals, braces, path separators) stays admissible.
    const realArgs = [
      "exec", "--ephemeral", "--ignore-user-config",
      "--config", "windows.sandbox='elevated'",
      "--config", "permissions.pair_workspace.filesystem={':minimal'='read','C:/ws'='write'}",
      "-C", "C:\\ws", "--json",
    ];
    expect(windowsSpawnTarget("C:\\x\\codex.cmd", realArgs)).not.toBeNull();
  });
});

/* ==================== B — executor lifecycle ==================== */

describe("B — governed executor lifecycle", () => {
  it("B1 dispatch → fixture writes workspace artifact → COMPLETED + journal", async () => {
    const d = dir("b1");
    const adapter = makeAdapter(d, { OPENAI_API_KEY: "test-key" });
    const task = makeTask(d, "GTSK_B1");
    const rec = adapter.dispatch(task);
    const o = await waitTerminal(adapter, String(rec.execution_id));
    expect(o.status).toBe("COMPLETED");
    expect(fs.existsSync(path.join(String(task.workspace), "codex_out.txt"))).toBe(true);
    const runRoot = codexRunRoot(path.join(d, "journal"), String(rec.execution_id));
    const journal = JSON.parse(fs.readFileSync(path.join(runRoot, "execution_journal.json"), "utf8"));
    expect(journal.status).toBe("COMPLETED");
    expect(journal.argv_sha256).toBeTruthy();
    const result = adapter.collect_result(String(rec.execution_id));
    expect(String(result.status)).toBe("COMPLETED");
  });

  it("B2 win32: argv carries windows.sandbox='elevated' alongside the profile", async () => {
    if (!isWin32) return;
    const d = dir("b2");
    const adapter = makeAdapter(d, { OPENAI_API_KEY: "test-key" });
    const rec = adapter.dispatch(makeTask(d, "GTSK_B2"));
    await waitTerminal(adapter, String(rec.execution_id));
    const final = JSON.parse(fs.readFileSync(
      path.join(codexRunRoot(path.join(d, "journal"), String(rec.execution_id)), "final.json"), "utf8"));
    const argv = final.argv as string[];
    expect(val(argv, "--config")).toContain("windows.sandbox='elevated'");
    expect(val(argv, "--config")).toContain("permissions.pair_workspace.network.enabled=false");
    expect(val(argv, "--config")).toContain("web_search=disabled");
    // No governance bypass flags anywhere in argv.
    expect(argv.join(" ")).not.toContain("dangerously");
    expect(argv.join(" ")).not.toContain("--full-auto");
  });

  it("B3 POSIX regression: no windows.sandbox in argv off-win32", async () => {
    if (isWin32) return;
    const d = dir("b3");
    const adapter = makeAdapter(d, { OPENAI_API_KEY: "test-key" });
    const rec = adapter.dispatch(makeTask(d, "GTSK_B3"));
    await waitTerminal(adapter, String(rec.execution_id));
    const final = JSON.parse(fs.readFileSync(
      path.join(codexRunRoot(path.join(d, "journal"), String(rec.execution_id)), "final.json"), "utf8"));
    expect(val(final.argv as string[], "--config").join(" ")).not.toContain("windows.sandbox");
  });

  it("B4 async spawn error settles FAILED fast — no hang to TIMEOUT", async () => {
    const d = dir("b4");
    spawnErr.armed = true;
    try {
      const adapter = new CodexCliExecutorAdapter({
        journalRoot: path.join(d, "journal"),
        executable: "node",
        executableArgs: ["-e", "process.exit(0)"],
        envReader: (nm: string) =>
          nm === "OPENAI_API_KEY" ? "test-key" : process.env[nm],
      });
      const t0 = Date.now();
      const rec = adapter.dispatch(makeTask(d, "GTSK_B4", ["FILE_WRITE"], { timeout: 300 }));
      const o = await waitTerminal(adapter, String(rec.execution_id), 15_000);
      expect(o.status).toBe("FAILED");
      const journal = JSON.parse(fs.readFileSync(
        path.join(codexRunRoot(path.join(d, "journal"), String(rec.execution_id)), "execution_journal.json"),
        "utf8"));
      expect(String(journal.error)).toContain("CODEX_SPAWN_FAILED");
      expect(Date.now() - t0).toBeLessThan(15_000);
    } finally {
      spawnErr.armed = false;
    }
  });

  it("B5 hanging child → TIMEOUT and killed", async () => {
    const d = dir("b5");
    const adapter = new CodexCliExecutorAdapter({
      journalRoot: path.join(d, "journal"),
      executable: "node",
      executableArgs: ["-e", "setTimeout(()=>{}, 300000)"],
      envReader: (nm: string) =>
        nm === "OPENAI_API_KEY" ? "test-key" : process.env[nm],
    });
    const rec = adapter.dispatch(makeTask(d, "GTSK_B5", ["FILE_WRITE"], { timeout: 2 }));
    const o = await waitTerminal(adapter, String(rec.execution_id), 15_000);
    expect(["TIMEOUT", "FAILED"]).toContain(o.status);
    const journal = JSON.parse(fs.readFileSync(
      path.join(codexRunRoot(path.join(d, "journal"), String(rec.execution_id)), "execution_journal.json"),
      "utf8"));
    expect(journal.status).toBe("TIMEOUT");
  });

  it("B6 cancellation settles CANCELLED", async () => {
    const d = dir("b6");
    const adapter = new CodexCliExecutorAdapter({
      journalRoot: path.join(d, "journal"),
      executable: "node",
      executableArgs: ["-e", "setTimeout(()=>{}, 300000)"],
      envReader: (nm: string) =>
        nm === "OPENAI_API_KEY" ? "test-key" : process.env[nm],
    });
    const rec = adapter.dispatch(makeTask(d, "GTSK_B6", ["FILE_WRITE"], { timeout: 300 }));
    await new Promise((r) => setTimeout(r, 400));
    adapter.cancel(String(rec.execution_id));
    const o = await waitTerminal(adapter, String(rec.execution_id), 15_000);
    expect(o.status).toBe("CANCELLED");
  });

  it("B7 child env carries Windows essentials, never ambient secrets", async () => {
    const d = dir("b7");
    const envDump = path.join(d, "env-dump.json");
    const adapter = new CodexCliExecutorAdapter({
      journalRoot: path.join(d, "journal"),
      executable: "node",
      executableArgs: ["-e", `
        const fs = require("node:fs");
        fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({
          systemroot: process.env.SYSTEMROOT ?? null,
          localappdata: process.env.LOCALAPPDATA ?? null,
          userprofile: process.env.USERPROFILE ?? null,
          leaked: process.env.PAIR_TEST_SECRET ?? null,
          networkFlag: process.env.PAIR_CODEX_NETWORK ?? null,
        }));
        process.exit(0);
      `],
      envReader: (nm: string) => {
        if (nm === "OPENAI_API_KEY") return "test-key";
        if (nm === "PAIR_TEST_SECRET") return "should-never-leak";
        if (nm === "PAIR_CODEX_NETWORK") return "on";
        return process.env[nm];
      },
    });
    const rec = adapter.dispatch(makeTask(d, "GTSK_B7"));
    await waitTerminal(adapter, String(rec.execution_id));
    const dumped = JSON.parse(fs.readFileSync(envDump, "utf8"));
    if (isWin32) {
      expect(dumped.systemroot).toBeTruthy();
      expect(dumped.localappdata).toBeTruthy();
      expect(dumped.userprofile).toBeTruthy();
    }
    expect(dumped.leaked).toBeNull();
    // Executor lane policy env never leaks into the child either.
    expect(dumped.networkFlag).toBeNull();
  });
});

/* ============ C — REAL codex-cli on the Windows host (live) ============ */

const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const realCodexExe = isWin32 ? resolveCodexExecutableSystem(undefined) : null;
const liveReady =
  isWin32 &&
  Boolean(realCodexExe) &&
  fs.existsSync(path.join(codexHome, "auth.json"));
const describeLive = liveReady ? describe : describe.skip;

describeLive("C — real codex-cli governed execution on this Windows host", () => {
  const liveAdapter = (d: string) => new CodexCliExecutorAdapter({
    journalRoot: path.join(d, "journal"),
    envReader: (nm: string) => {
      if (nm === "CODEX_HOME") return codexHome;
      if (nm === "OPENAI_API_KEY" || nm === "CODEX_API_KEY") return process.env[nm];
      return process.env[nm];
    },
  });

  it("C1 [E2] governed codex task runs the REAL CLI sandboxed, writes workspace artifact, COMPLETED", async () => {
    const d = dir("c1");
    const adapter = liveAdapter(d);
    const task = makeTask(d, "GTSK_C1", ["FILE_WRITE"], {
      timeout: 240,
      task_instruction:
        "Write a file named e2_artifact.txt in the current directory containing exactly: P0_E2_DONE . Then reply DONE.",
    });
    const rec = adapter.dispatch(task);
    const o = await waitTerminal(adapter, String(rec.execution_id), 240_000);
    const runRoot = codexRunRoot(path.join(d, "journal"), String(rec.execution_id));
    const journal = JSON.parse(fs.readFileSync(path.join(runRoot, "execution_journal.json"), "utf8"));
    const transcript = fs.existsSync(path.join(runRoot, "stdout.jsonl"))
      ? fs.readFileSync(path.join(runRoot, "stdout.jsonl"), "utf8")
      : "";
    // Sandbox actually engaged: tool calls run as CodexSandboxOffline,
    // and the blocked-by-policy signature must be absent.
    expect(transcript).not.toContain("blocked by policy");
    expect(o.status).toBe("COMPLETED");
    expect(journal.status).toBe("COMPLETED");
    const written = path.join(String(task.workspace), "e2_artifact.txt");
    expect(fs.existsSync(written)).toBe(true);
    const result = adapter.collect_result(String(rec.execution_id));
    expect(String(result.status)).toBe("COMPLETED");
  }, 260_000);

  it("C2 real ingest: the workspace artifact ACCEPTED via canonical authority", async () => {
    const d = dir("c2");
    const adapter = liveAdapter(d);
    const task = makeTask(d, "GTSK_C2", ["FILE_WRITE"], {
      timeout: 240,
      task_instruction:
        "Write a file named e2_artifact.txt in the current directory containing exactly: P0_E2_BYTES . Then declare it in your final JSON artifacts. Then reply DONE.",
    });
    const rec = adapter.dispatch(task);
    const o = await waitTerminal(adapter, String(rec.execution_id), 240_000);
    expect(o.status).toBe("COMPLETED");
    const written = path.join(String(task.workspace), "e2_artifact.txt");
    expect(fs.existsSync(written)).toBe(true);
    // Canonical ingest seam on the produced artifact — full
    // opened-object proof + CAS retention + ACCEPTED state. The accept
    // path binds the execution against canonical rows, so persist the
    // minimal governed chain for THIS execution id.
    const store = new PairEvidenceStore(path.join(d, "pair.db"));
    const service = new PairControlPlane(store);
    const project = service.createProject({ name: "p", root_location: String(task.workspace) });
    const mission = service.createMission({
      project_id: String(project.project_id),
      goal: "p0-c2",
      granted_permissions: ["FILE_WRITE"],
      authorized_workspaces: [String(task.workspace)],
    });
    service.commitPlan({ mission_id: String(mission.mission_id), tasks: [], source: "TEST", proposal: null });
    const mid = String(mission.mission_id);
    const tid = String(task.task_id);
    const gtid = String(task.governed_task_id);
    store.put("task", tid, {
      task_id: tid, task_key: "T2", mission_id: mid, plan_id: "PLAN_C2",
      title: tid, task_instruction: String(task.task_instruction), status: "COMPLETED",
      required_capabilities: ["FILE_OPERATIONS"], depends_on: [],
      metadata: { pair_dataflow: { produces: ["e2_artifact.txt"], consumes: [] } }, version: 0,
    }, 0);
    store.put("governed_task", gtid, {
      governed_task_id: gtid, mission_id: mid, task_id: tid,
      correlation_id: String(task.correlation_id), executor_id: CODEX_EXECUTOR_ID,
      plan_id: "PLAN_C2", plan_revision: 1, workspace: String(task.workspace),
      allowed_paths: [String(task.workspace)], governance_state: "DISPATCH_AUTHORIZED",
      dispatch_enabled: true, created_at: utcnow(), version: 0,
    }, 0);
    store.put("executor_execution", String(rec.execution_id), {
      execution_id: String(rec.execution_id), governed_task_id: gtid,
      mission_id: mid, task_id: tid, executor_id: CODEX_EXECUTOR_ID, plan_revision: 1,
      correlation_id: String(task.correlation_id), execution_state: "COMPLETED",
      dispatch_timestamp: utcnow(), workspace: String(task.workspace), version: 0,
      result: adapter.collect_result(String(rec.execution_id)),
    }, 0);
    const bytes = fs.readFileSync(written);
    const r = service.artifacts.accept({
      execution_id: String(rec.execution_id),
      producer_executor_id: CODEX_EXECUTOR_ID,
      logical_name: "e2_artifact.txt",
      source: { kind: "path", path: written },
      channel: "LOCAL_EXECUTION",
      actor: "P0_LIVE",
      allow_post_result: true,
    });
    expect(String(r.artifact.state)).toBe("ACCEPTED");
    expect(String(r.artifact.sha256)).toBe(sha256Hex(bytes));
  }, 260_000);

  it("C3 red control: same argv WITHOUT windows.sandbox → governed shell rejected", async () => {
    const d = dir("c3");
    const ws = path.join(d, "ws"); fs.mkdirSync(ws);
    const wsf = ws.replace(/\\/g, "/");
    const args = [
      "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config",
      "--ignore-rules", "--strict-config", "--color", "never",
      "--config", "approval_policy=never",
      "--config", "web_search=disabled",
      "--config", "default_permissions=pair_workspace",
      "--config", "permissions.pair_workspace.extends=:workspace",
      "--config", `permissions.pair_workspace.filesystem={':minimal'='read','${wsf}'='write'}`,
      "--config", "permissions.pair_workspace.network.enabled=false",
      "--config", `permissions.pair_workspace.workspace_roots={'${wsf}'=true}`,
      "-C", ws, "--json",
    ];
    const out = await new Promise<string>((resolve) => {
      // Minimal controlled env — same whitelist discipline as the
      // adapter's childEnv; no ambient credential names forwarded.
      const env: Record<string, string> = { CODEX_HOME: codexHome };
      for (const k of ["PATH", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT",
        "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData",
        "HOMEDRIVE", "HOMEPATH", "USERNAME", "OS", "PUBLIC"]) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
      const c = spawn(String(realCodexExe), args, { cwd: ws, stdio: ["pipe", "pipe", "pipe"], env });
      c.stdin.write("Run the command: whoami");
      c.stdin.end();
      let buf = "";
      c.stdout.on("data", (x) => (buf += x));
      const to = setTimeout(() => { c.kill("SIGKILL"); resolve(buf); }, 150_000);
      c.on("exit", () => { clearTimeout(to); resolve(buf); });
      c.on("error", () => { clearTimeout(to); resolve(buf); });
    });
    // Elevated config absent → the sandbox policy rejects governed
    // tool execution. PAIR never weakens this boundary.
    expect(out).toMatch(/blocked|Rejected|rejected/i);
    expect(fs.existsSync(path.join(ws, "marker.txt"))).toBe(false);
  }, 170_000);
});


