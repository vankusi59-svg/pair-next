/**
 * Development Workflow Policy V1 — proof that the repository-root
 * AGENTS.md carries the mandatory development completion contract.
 * Dev-infra guard only: reads a documentation file, touches no runtime.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const AGENTS = join(ROOT, "AGENTS.md");

describe("AGENTS.md development completion contract", () => {
  it("exists at repository root", () => {
    expect(existsSync(AGENTS)).toBe(true);
  });

  const body = () => readFileSync(AGENTS, "utf8");

  it("mandates verify:change against a recorded BASE SHA", () => {
    const t = body();
    expect(t).toContain("BASE SHA");
    expect(t).toContain("npm run verify:change -- --base");
  });

  it("requires READY_FOR_INDEPENDENT_AUDIT as minimum completion evidence", () => {
    const t = body();
    expect(t).toContain("READY_FOR_INDEPENDENT_AUDIT");
    expect(t).toContain("minimum completion evidence");
  });

  it("forbids reporting completion while NOT_READY", () => {
    const t = body();
    expect(t).toContain("NOT_READY");
    expect(t).toMatch(/MUST NOT report implementation completion/);
  });

  it("binds the patch claim to the current BASE..HEAD diff", () => {
    const t = body();
    expect(t).toContain(".pair-verification/patch-claim.json");
    expect(t).toContain("BASE..HEAD");
  });

  it("forbids self-merge without explicit operator instruction", () => {
    const t = body();
    expect(t).toMatch(/MUST NOT merge its own PR/);
    expect(t).toContain("independent audit");
  });
});
