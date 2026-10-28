/**
 * Live-stack launcher flag pins — scripts/start-pair-live.sh must export the
 * operator-posture env the verified live configuration runs under, with
 * overridable ${VAR:-default} form so a fresh clone reproduces this stack:
 * guarded semantic gating + the governed objective auto-driver enabled.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(__dirname, "../../scripts/start-pair-live.sh");
const src = readFileSync(SCRIPT, "utf8");

/** The server env block feeding serve-mission-control.mjs. */
const serveBlock = src.match(
  /PAIR_MC_DIR="\$MC_DIR"[\s\S]*?nohup node scripts\/serve-mission-control\.mjs/,
);

describe("start-pair-live.sh — governed runtime flag pins", () => {
  it("exports PAIR_SEMANTIC_MODE defaulting to guarded, overridable", () => {
    expect(serveBlock, "server env block not found").toBeTruthy();
    expect(serveBlock![0]).toMatch(
      /PAIR_SEMANTIC_MODE="\$\{PAIR_SEMANTIC_MODE:-guarded\}"/,
    );
  });

  it("exports PAIR_OBJECTIVE_AUTO_DRIVER defaulting to 1, overridable", () => {
    expect(serveBlock, "server env block not found").toBeTruthy();
    expect(serveBlock![0]).toMatch(
      /PAIR_OBJECTIVE_AUTO_DRIVER="\$\{PAIR_OBJECTIVE_AUTO_DRIVER:-1\}"/,
    );
  });

  it("each flag appears exactly once — no duplicate hard-pin elsewhere", () => {
    expect(src.match(/PAIR_SEMANTIC_MODE=/g) ?? []).toHaveLength(1);
    expect(src.match(/PAIR_OBJECTIVE_AUTO_DRIVER=/g) ?? []).toHaveLength(1);
  });
});
