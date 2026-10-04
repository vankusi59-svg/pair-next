/**
 * CNI-1 — CODEX ambient unrestricted internet access (Option B+).
 *
 * PAIR_CODEX_NETWORK is the ONE server-level authority for ambient
 * internet on the CODEX executor: resolved per dispatch via envReader,
 * fail-closed, binds BOTH `permissions.<profile>.network.enabled` and
 * `web_search` to the same value. argv evidence remains argv_sha256 in
 * the execution journal; the exact argv is captured through the
 * fake-codex-argv fixture's final.json.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexCliExecutorAdapter,
  CODEX_EXECUTOR_ID,
  codexRunRoot,
} from "../pair/index.js";

const FAKE_ARGV_CODEX = path.resolve(__dirname, "fixtures", "fake-codex-argv.mjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pair-cni1-"));
let counter = 0;
const freshDir = (n: string) => {
  const p = path.join(ROOT, `${counter++}-${n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeAdapter(dir: string, envMap: Record<string, string | undefined>) {
  return new CodexCliExecutorAdapter({
    journalRoot: path.join(dir, "journal"),
    executable: "node",
    executableArgs: [FAKE_ARGV_CODEX],
    // Keys present in envMap (even as undefined) block process.env
    // fall-through so "unset" is a real test case; everything else
    // (PATH, HOME, …) inherits the test process environment.
    envReader: (n: string) => (n in envMap ? envMap[n] : process.env[n]),
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
    mission_id: "MSN_CNI1",
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

async function dispatchAndCaptureArgv(
  adapter: CodexCliExecutorAdapter,
  task: Record<string, unknown>,
  journalRoot: string,
): Promise<{ argv: string[]; journal: Record<string, unknown> }> {
  const rec = adapter.dispatch(task);
  const execId = String(rec.execution_id);
  await waitTerminal(adapter, execId);
  const runRoot = codexRunRoot(journalRoot, execId);
  const final = JSON.parse(fs.readFileSync(path.join(runRoot, "final.json"), "utf8"));
  const journal = JSON.parse(
    fs.readFileSync(path.join(runRoot, "execution_journal.json"), "utf8"),
  );
  return { argv: final.argv as string[], journal };
}

const val = (argv: string[], flag: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return out;
};

describe("CNI-1 A: truthy PAIR_CODEX_NETWORK → network.enabled=true + web_search=live", () => {
  for (const v of ["on", "ON", "On", "true", "TRUE", "1", " on ", "\ttrue\n"]) {
    it(`env=${JSON.stringify(v)} → ON argv`, async () => {
      const dir = freshDir("a");
      const adapter = makeAdapter(dir, {
        OPENAI_API_KEY: "test-key",
        PAIR_CODEX_NETWORK: v,
      });
      const { argv } = await dispatchAndCaptureArgv(
        adapter,
        makeTask(dir, `GTSK_A_${v.replace(/\s/g, "_")}`),
        path.join(dir, "journal"),
      );
      expect(val(argv, "--config")).toContain("permissions.pair_workspace.network.enabled=true");
      expect(val(argv, "--config")).toContain("web_search=live");
    }, 40_000);
  }
});

describe("CNI-1 B: fail-closed values → OFF argv identical to pre-change behavior", () => {
  for (const v of [undefined, "", "off", "false", "yes", "enabled", "2", "garbage-!!"]) {
    it(`env=${JSON.stringify(v)} → OFF argv`, async () => {
      const dir = freshDir("b");
      const adapter = makeAdapter(dir, {
        OPENAI_API_KEY: "test-key",
        PAIR_CODEX_NETWORK: v,
      });
      const { argv } = await dispatchAndCaptureArgv(
        adapter,
        makeTask(dir, `GTSK_B_${String(v).replace(/\W/g, "_")}`),
        path.join(dir, "journal"),
      );
      expect(val(argv, "--config")).toContain("permissions.pair_workspace.network.enabled=false");
      expect(val(argv, "--config")).toContain("web_search=disabled");
      // OFF regression lock (H): exactly one network.enabled literal, the
      // historical false — no extra network authority sneaks into argv.
      const cfg = val(argv, "--config");
      expect(cfg.filter((c) => c.includes("network.enabled"))).toEqual([
        "permissions.pair_workspace.network.enabled=false",
      ]);
      expect(cfg.filter((c) => c.startsWith("web_search="))).toEqual(["web_search=disabled"]);
    }, 40_000);
  }
});

describe("CNI-1 C: sandbox profile regression under network ON", () => {
  it("filesystem/approval/workspace/strict flags unchanged", async () => {
    const dir = freshDir("c");
    const adapter = makeAdapter(dir, {
      OPENAI_API_KEY: "test-key",
      PAIR_CODEX_NETWORK: "on",
    });
    const task = makeTask(dir, "GTSK_C1");
    const { argv } = await dispatchAndCaptureArgv(
      adapter,
      task,
      path.join(dir, "journal"),
    );
    const cfg = val(argv, "--config");
    expect(cfg).toContain("approval_policy=never");
    expect(cfg).toContain("default_permissions=pair_workspace");
    expect(cfg).toContain("permissions.pair_workspace.extends=:workspace");
    const ws = path.resolve(String(task.workspace));
    expect(cfg).toContain(
      `permissions.pair_workspace.filesystem={':minimal'='read','${ws}'='write'}`,
    );
    expect(cfg).toContain(`permissions.pair_workspace.workspace_roots={'${ws}'=true}`);
    for (const flag of [
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
    ]) {
      expect(argv).toContain(flag);
    }
  }, 40_000);
});

describe("CNI-1 D: dispatch authorization regression — net ON bypasses nothing", () => {
  it("missing field / routing mismatch / unauthorized state / missing workspace still fail closed", async () => {
    const dir = freshDir("d");
    const adapter = makeAdapter(dir, {
      OPENAI_API_KEY: "test-key",
      PAIR_CODEX_NETWORK: "on",
    });
    const base = makeTask(dir, "GTSK_D1");
    const missing = { ...base };
    delete missing.governed_task_id;
    expect(() => adapter.dispatch(missing)).toThrowError(/FAIL_CLOSED_REQUEST_FIELD_MISSING/);
    expect(() =>
      adapter.dispatch({ ...base, governed_task_id: "GTSK_D2", executor_id: "DSH" }),
    ).toThrowError(/FAIL_CLOSED_EXECUTOR_ROUTING_MISMATCH/);
    expect(() =>
      adapter.dispatch({ ...base, governed_task_id: "GTSK_D3", governance_state: "VALIDATED" }),
    ).toThrowError(/FAIL_CLOSED_GOVERNED_TASK_NOT_DISPATCH_AUTHORIZED/);
    const gone = makeTask(dir, "GTSK_D4");
    fs.rmdirSync(String(gone.workspace));
    expect(() => adapter.dispatch(gone)).toThrowError(/FAIL_CLOSED_WORKSPACE_MISSING/);
  });
});

describe("CNI-1 E: no sticky cache — env change affects next dispatch on same adapter", () => {
  it("dispatch1 ON → env off → dispatch2 OFF", async () => {
    const dir = freshDir("e");
    const envMap: Record<string, string | undefined> = {
      OPENAI_API_KEY: "test-key",
      PAIR_CODEX_NETWORK: "on",
    };
    const adapter = makeAdapter(dir, envMap);
    const jr = path.join(dir, "journal");
    const d1 = await dispatchAndCaptureArgv(adapter, makeTask(dir, "GTSK_E1"), jr);
    expect(val(d1.argv, "--config")).toContain("permissions.pair_workspace.network.enabled=true");
    envMap.PAIR_CODEX_NETWORK = "off";
    const d2 = await dispatchAndCaptureArgv(adapter, makeTask(dir, "GTSK_E2"), jr);
    expect(val(d2.argv, "--config")).toContain("permissions.pair_workspace.network.enabled=false");
    expect(val(d2.argv, "--config")).toContain("web_search=disabled");
    envMap.PAIR_CODEX_NETWORK = "1";
    const d3 = await dispatchAndCaptureArgv(adapter, makeTask(dir, "GTSK_E3"), jr);
    expect(val(d3.argv, "--config")).toContain("permissions.pair_workspace.network.enabled=true");
    expect(val(d3.argv, "--config")).toContain("web_search=live");
  }, 60_000);
});

describe("CNI-1 F: argv evidence — argv_sha256 distinguishes ON vs OFF via net config only", () => {
  it("normalized argv differ ONLY in network/web_search; digests differ", async () => {
    const dirOn = freshDir("fon");
    const dirOff = freshDir("foff");
    const mk = (dir: string, net: string | undefined) =>
      makeAdapter(dir, { OPENAI_API_KEY: "test-key", PAIR_CODEX_NETWORK: net });
    const on = await dispatchAndCaptureArgv(
      mk(dirOn, "on"),
      makeTask(dirOn, "GTSK_F1"),
      path.join(dirOn, "journal"),
    );
    const off = await dispatchAndCaptureArgv(
      mk(dirOff, undefined),
      makeTask(dirOff, "GTSK_F1"),
      path.join(dirOff, "journal"),
    );
    expect(on.journal.argv_sha256).not.toBe(off.journal.argv_sha256);
    // Normalize run-root/env-specific argv segments, then the only
    // remaining differences must be the network/web_search literals.
    const norm = (argv: string[], dir: string) =>
      argv.map((a) => a.replaceAll(dir, "<DIR>"));
    const onN = norm(on.argv, dirOn);
    const offN = norm(off.argv, dirOff);
    expect(onN.length).toBe(offN.length);
    const diffs: Array<[string, string]> = [];
    for (let i = 0; i < onN.length; i++) {
      if (onN[i] !== offN[i]) diffs.push([onN[i], offN[i]]);
    }
    expect(diffs).toEqual([
      ["web_search=live", "web_search=disabled"],
      [
        "permissions.pair_workspace.network.enabled=true",
        "permissions.pair_workspace.network.enabled=false",
      ],
    ]);
    // No credential material anywhere in argv or journal.
    const blob = JSON.stringify({ argv: on.argv, journal: on.journal });
    expect(blob).not.toContain("test-key");
  }, 60_000);
});

describe("CNI-1 G: both permission profiles covered", () => {
  it("pair_read task → pair_read.network.enabled=true; pair_workspace → pair_workspace.network.enabled=true", async () => {
    const dir = freshDir("g");
    const adapter = makeAdapter(dir, {
      OPENAI_API_KEY: "test-key",
      PAIR_CODEX_NETWORK: "true",
    });
    const jr = path.join(dir, "journal");
    const ro = await dispatchAndCaptureArgv(
      adapter,
      makeTask(dir, "GTSK_G1", ["FILE_READ"]),
      jr,
    );
    const cfgRo = val(ro.argv, "--config");
    expect(cfgRo).toContain("default_permissions=pair_read");
    expect(cfgRo).toContain("permissions.pair_read.network.enabled=true");
    expect(cfgRo.filter((c) => c.includes("pair_workspace"))).toEqual([]);
    expect(cfgRo).toContain("web_search=live");
    const wr = await dispatchAndCaptureArgv(
      adapter,
      makeTask(dir, "GTSK_G2", ["FILE_WRITE"]),
      jr,
    );
    const cfgWr = val(wr.argv, "--config");
    expect(cfgWr).toContain("default_permissions=pair_workspace");
    expect(cfgWr).toContain("permissions.pair_workspace.network.enabled=true");
    expect(cfgWr.filter((c) => c.includes("pair_read"))).toEqual([]);
    expect(cfgWr).toContain("web_search=live");
  }, 60_000);
});

describe("CNI-1: child environment does not inherit PAIR_CODEX_NETWORK", () => {
  it("fixture sees no PAIR_CODEX_NETWORK in spawned env", async () => {
    const dir = freshDir("env");
    const adapter = makeAdapter(dir, {
      OPENAI_API_KEY: "test-key",
      PAIR_CODEX_NETWORK: "on",
    });
    const rec = adapter.dispatch(makeTask(dir, "GTSK_ENV1"));
    await waitTerminal(adapter, String(rec.execution_id));
    const final = JSON.parse(
      fs.readFileSync(
        path.join(codexRunRoot(path.join(dir, "journal"), String(rec.execution_id)), "final.json"),
        "utf8",
      ),
    );
    expect(final.codex_network_env ?? null).toBeNull();
  }, 40_000);
});
