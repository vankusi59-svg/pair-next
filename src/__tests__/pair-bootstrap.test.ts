/**
 * P-BOOT R1 — pair-bootstrap.sh hardening tests.
 *
 * Every case runs the real script under a scratch HOME + a fakebin PATH of
 * command stubs (npm, pnpm, codex, curl, corepack) so no test depends on the
 * host machine's real installs and no real install ever executes. Mutating
 * stubs append their argv to $STUB_LOG — check-mode cases assert it stays
 * empty; filesystem cases snapshot the whole scratch tree before/after.
 *
 * Coverage (mandate): --check zero fs mutation + zero install/patch exec;
 * fresh-host install exit 0 with no stale MISS; patch failure fail-closed;
 * marker-verified patch check in --check; .imported settings preserved;
 * empty TG token = MISS; placeholder allowlist = MISS; idempotent second run.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO, "scripts/pair-bootstrap.sh");
const COMPAT = path.join(REPO, "scripts/dsh-gemini-compat.sh");

const PI_AI_REL = "@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
const DSH_PKG_REL = "@deepseek-ai/dsh/package.json";

/** Pull the two patch anchors out of the compat script so the fixture always
 *  matches the patcher byte-for-byte. */
function patchAnchors(): { a: string; b: string } {
  const src = fs.readFileSync(COMPAT, "utf8");
  const grab = (name: string) => {
    const m = src.match(new RegExp(`${name} = """([\\s\\S]*?)"""`));
    if (!m) throw new Error(`anchor ${name} not in compat script`);
    return m[1];
  };
  return { a: grab("a"), b: grab("c") };
}

function piAiContent(kind: "patched" | "unpatched" | "broken"): string {
  if (kind === "broken") return "// upstream changed; anchors gone\n";
  const { a, b } = patchAnchors();
  if (kind === "unpatched") return `// pi-ai\n${a}\nmid\n${b}\n`;
  const patchedA = a.replace(
    "if (!block.id",
    "if (toolCall.extra_content !== undefined) {\n                                block.extraContent = toolCall.extra_content;\n                            }\n                            if (!block.id",
  );
  return `// pi-ai\n${patchedA}\nmid\nconst geminiThoughtSignature = x;\n`;
}

interface Env {
  home: string;
  fakebin: string;
  npmRoot: string;
  log: string;
  env: NodeJS.ProcessEnv;
}
interface Opts {
  pnpmVersion?: string; // default pinned 10.28.1
  dshInstalled?: boolean; // preinstall dsh dir under npmRoot
  dshVersion?: string;
  piAi?: "patched" | "unpatched" | "broken" | "absent";
  secrets?: boolean; // set TG token + provider envs
  allow?: "ready" | "placeholder" | "broken-json" | "absent";
  imported?: string; // settings.yaml.imported content
  settingsYaml?: boolean; // pre-create a valid settings.yaml
  cloudflared?: boolean; // pre-install a cloudflared stub
  tgTokenFile?: "ok" | "empty";
}

function mkEnv(o: Opts): Env {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pair-boot-"));
  const fakebin = path.join(home, "fakebin");
  const npmRoot = path.join(home, "npm-global");
  const log = path.join(home, "stub.log");
  fs.mkdirSync(fakebin, { recursive: true });
  fs.mkdirSync(npmRoot, { recursive: true });
  const stub = (name: string, body: string) => {
    fs.writeFileSync(path.join(fakebin, name), `#!/bin/sh\n${body}`);
    fs.chmodSync(path.join(fakebin, name), 0o755);
  };

  stub("node", 'case "$1" in -v) echo v22.23.3;; *) echo v22.23.3;; esac');
  stub("pnpm", 'case "$1" in -v) echo "${STUB_PNPM_VERSION:-10.28.1}";; install|build) exit 0;; esac');
  stub("corepack", 'echo "corepack $*" >> "$STUB_LOG"');
  stub("curl", `echo "curl $*" >> "$STUB_LOG"
while [ $# -gt 0 ]; do case "$1" in -o) echo stub-binary > "$2"; shift;; esac; shift; done`);
  stub("codex", 'echo "codex-cli 0.159.3"');
  if (o.cloudflared) stub("cloudflared", "echo cloudflared-stub");
  stub("npm", `case "$1 $2" in
  "root -g") echo "$STUB_NPM_ROOT"; exit 0;;
esac
echo "npm $*" >> "$STUB_LOG"
case "$*" in
  "install -g @deepseek-ai/dsh"*)
    mkdir -p "$STUB_NPM_ROOT/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api"
    printf '{"version":"0.2.0-rc.2"}' > "$STUB_NPM_ROOT/@deepseek-ai/dsh/package.json"
    if [ -n "$STUB_PI_AI_SRC" ]; then cp "$STUB_PI_AI_SRC" "$STUB_NPM_ROOT/${PI_AI_REL}"; fi
    printf '#!/bin/sh\\nexit 0\\n' > "$STUB_FAKEBIN/dsh"; chmod +x "$STUB_FAKEBIN/dsh";;
esac`);

  if (o.dshInstalled) {
    const pkgDir = path.join(npmRoot, "@deepseek-ai/dsh");
    fs.mkdirSync(path.dirname(path.join(npmRoot, PI_AI_REL)), { recursive: true });
    fs.writeFileSync(
      path.join(npmRoot, DSH_PKG_REL),
      JSON.stringify({ version: o.dshVersion ?? "0.2.0-rc.2" }),
    );
    const kind = o.piAi ?? "unpatched";
    if (kind !== "absent") {
      fs.writeFileSync(path.join(npmRoot, PI_AI_REL), piAiContent(kind));
    }
    stub("dsh", "exit 0");
  }
  if (o.settingsYaml) {
    const dsh = path.join(home, ".pair-dsh-home");
    fs.mkdirSync(dsh, { recursive: true });
    fs.writeFileSync(path.join(dsh, "settings.yaml"), "llm-pi-ai: {}\n");
  }
  if (o.imported !== undefined) {
    const dsh = path.join(home, ".pair-dsh-home");
    fs.mkdirSync(dsh, { recursive: true });
    fs.writeFileSync(path.join(dsh, "settings.yaml.imported"), o.imported);
  }
  if (o.tgTokenFile) {
    fs.writeFileSync(path.join(home, "pair-tg-token"), o.tgTokenFile === "ok" ? "tok" : "");
  }
  if (o.allow && o.allow !== "absent") {
    const mc = path.join(home, "pair-mc-live");
    fs.mkdirSync(mc, { recursive: true });
    const content =
      o.allow === "ready"
        ? '["12345"]\n'
        : o.allow === "placeholder"
          ? '["PUT_YOUR_TELEGRAM_CHAT_ID"]\n'
          : "not-json{";
    fs.writeFileSync(path.join(mc, "telegram-allow.json"), content);
  }

  const env: NodeJS.ProcessEnv = {
    PATH: `${fakebin}:/usr/bin:/bin`,
    HOME: home,
    STUB_NPM_ROOT: npmRoot,
    STUB_FAKEBIN: fakebin,
    STUB_LOG: log,
    STUB_PI_AI_SRC: "",
    STUB_PNPM_VERSION: o.pnpmVersion ?? "10.28.1",
    PAIR_TG_CHAT_ID: "12345",
  };
  if (!o.dshInstalled && o.piAi !== "absent") {
    // the npm stub "installs" dsh by copying this fixture into place —
    // fresh-host cases therefore exercise the real patcher end-to-end.
    const fixture = path.join(home, "pi-ai-fixture.js");
    fs.writeFileSync(fixture, piAiContent(o.piAi ?? "unpatched"));
    env.STUB_PI_AI_SRC = fixture;
  }
  if (o.secrets) {
    Object.assign(env, {
      PAIR_TG_BOT_TOKEN: "tg-stub",
      GROQ_API_KEY: "g-stub",
      CLOUDFLARE_API_TOKEN: "cf-stub",
      GEMINI_API_KEY: "gm-stub",
    });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex/auth.json"), "{}");
  }
  return { home, fakebin, npmRoot, log, env };
}

function run(e: Env, args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [SCRIPT, ...args], { env: e.env, encoding: "utf8" });
    return { code: 0, out };
  } catch (err) {
    const x = err as { status?: number; stdout?: string };
    return { code: x.status ?? 99, out: String(x.stdout ?? "") };
  }
}

function treeSnapshot(dir: string): string {
  const entries: string[] = [];
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      entries.push(
        st.isDirectory() ? `d ${p}` : `f ${p} ${st.size} ${fs.readFileSync(p).toString("base64").length}`,
      );
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return entries.join("\n");
}

describe("pair-bootstrap.sh — R1 hardening", () => {
  it("A1: --check is byte-identical read-only on a dirty scratch host", () => {
    const e = mkEnv({ dshInstalled: true, piAi: "unpatched", allow: "placeholder", secrets: false });
    const before = treeSnapshot(e.home);
    const r = run(e, ["--check"]);
    expect(r.code).not.toBe(0);
    expect(treeSnapshot(e.home)).toBe(before);
    expect(r.out).not.toMatch(/\[did\]/);
    expect(fs.existsSync(e.log)).toBe(false); // zero install/patch command ran
  });

  it("A2: --check on clean scratch host mutates nothing and runs no installer", () => {
    const e = mkEnv({});
    const r = run(e, ["--check"]);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(e.log)).toBe(false);
    expect(fs.existsSync(path.join(e.home, "pair-mc-live"))).toBe(false);
    expect(fs.existsSync(path.join(e.home, "cloudflared"))).toBe(false);
  });

  it("B1: fresh-host install with secrets → exit 0, no stale MISS on installed items", () => {
    const e = mkEnv({ secrets: true });
    const r = run(e);
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 still missing");
    const final = r.out.split("==> final state")[1];
    expect(final).not.toContain("[MISS] dsh executor");
    expect(final).not.toContain("[MISS] codex CLI");
    expect(final).not.toContain("[MISS] cloudflared");
    expect(r.out).toContain("[did]  dsh gemini compat patch verified");
    // patch marker really landed on the fake pi-ai file
    expect(fs.readFileSync(path.join(e.npmRoot, PI_AI_REL), "utf8")).toContain("geminiThoughtSignature");
  });

  it("C1: incompatible upstream pi-ai → patch fails closed, nonzero exit", () => {
    const e = mkEnv({ dshInstalled: true, piAi: "broken", secrets: true });
    const r = run(e);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/dsh gemini compat patch (FAILED|\[MISS\])/);
    expect(r.out).toMatch(/\[MISS\] dsh gemini compat patch/);
  });

  it("C2: --check verifies the real marker — unpatched reports MISS, patched ok", () => {
    const e1 = mkEnv({ dshInstalled: true, piAi: "unpatched" });
    const r1 = run(e1, ["--check"]);
    expect(r1.out).toMatch(/\[MISS\] dsh gemini compat patch/);
    expect(r1.code).not.toBe(0);
    const e2 = mkEnv({ dshInstalled: true, piAi: "patched", secrets: true, settingsYaml: true, allow: "ready", cloudflared: true });
    const r2 = run(e2, ["--check"]);
    expect(r2.out).toContain("[ok]   dsh gemini compat patch (marker verified)");
    expect(r2.code).toBe(0);
  });

  it("D1: settings.yaml.imported is restored verbatim, never overwritten by template", () => {
    const e = mkEnv({ dshInstalled: true, piAi: "patched", imported: "CUSTOM-IMPORTED-CONTENT-9f3a", secrets: true });
    const r = run(e);
    expect(r.code).toBe(0);
    const settings = fs.readFileSync(path.join(e.home, ".pair-dsh-home/settings.yaml"), "utf8");
    expect(settings).toBe("CUSTOM-IMPORTED-CONTENT-9f3a");
    expect(r.out).toContain("restored from .imported");
  });

  it("D2: --check only reports a missing canonical + present imported", () => {
    const e = mkEnv({ dshInstalled: true, piAi: "patched", imported: "X", secrets: true });
    const r = run(e, ["--check"]);
    expect(r.out).toMatch(/\[MISS\] dsh settings\.yaml \(settings\.yaml\.imported present/);
    expect(fs.existsSync(path.join(e.home, ".pair-dsh-home/settings.yaml"))).toBe(false);
  });

  it("E1: wrong pnpm version is a MISS in check, fixed via corepack pin in install", () => {
    const e = mkEnv({ pnpmVersion: "9.0.0", dshInstalled: true, piAi: "patched", secrets: true });
    const rc = run(e, ["--check"]);
    expect(rc.out).toMatch(/\[MISS\] pnpm@10\.28\.1 \(have 9\.0\.0\)/);
    expect(rc.code).not.toBe(0);
    const ri = run(e);
    expect(fs.readFileSync(e.log, "utf8")).toContain("corepack prepare pnpm@10.28.1 --activate");
  });

  it("F1: empty pair-tg-token file counts as missing, not configured", () => {
    const e = mkEnv({ dshInstalled: true, piAi: "patched", secrets: true, tgTokenFile: "empty" });
    delete e.env.PAIR_TG_BOT_TOKEN;
    const r = run(e, ["--check"]);
    expect(r.out).toMatch(/\[MISS\] PAIR_TG_BOT_TOKEN or ~\/pair-tg-token \(non-empty\)/);
    expect(r.code).not.toBe(0);
  });

  it("F2: placeholder / broken allowlist is never 'ready'", () => {
    for (const allow of ["placeholder", "broken-json"] as const) {
      const e = mkEnv({ dshInstalled: true, piAi: "patched", secrets: true, allow });
      const r = run(e, ["--check"]);
      expect(r.out).toMatch(/\[MISS\] telegram-allow\.json/);
      expect(r.code).not.toBe(0);
    }
  });

  it("F3: optional NVIDIA_API_KEY absent → info only, not a MISS", () => {
    const e = mkEnv({ dshInstalled: true, piAi: "patched", secrets: true, allow: "ready", settingsYaml: true, cloudflared: true });
    const r = run(e, ["--check"]);
    expect(r.out).toContain("[info] NVIDIA_API_KEY unset");
    expect(r.code).toBe(0);
  });

  it("B2: second install run is idempotent — installs nothing, still exit 0", () => {
    const e = mkEnv({ secrets: true });
    expect(run(e).code).toBe(0);
    fs.writeFileSync(e.log, ""); // reset install log
    const r2 = run(e);
    expect(r2.code).toBe(0);
    const log = fs.readFileSync(e.log, "utf8");
    expect(log).not.toContain("npm install");
    expect(log).not.toContain("corepack");
    expect(log).not.toContain("curl");
  });
});
