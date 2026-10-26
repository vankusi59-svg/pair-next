/**
 * Vitest globalSetup — runs once per suite invocation, before any
 * worker spawns. Sweeps stale test-tmp dirs leaked by interrupted or
 * crashed runs (the ~20 GB ENOSPC incident class). Age-gated far above
 * a run's residency so a still-running parallel invocation is never
 * disturbed; prefix-allowlisted so foreign temp entries are never
 * touched. Report lands on stderr for CI visibility.
 */
import { sweepStaleTestDirs } from "./src/test-utils/tmpdir.js";

export default function globalSetup(): void {
  const res = sweepStaleTestDirs();
  if (res.removed > 0 || res.scanned > 0) {
    console.error(
      `[tmp-sweep] scanned=${res.scanned} removed=${res.removed} ` +
        `skipped=${res.skipped} bytesFreed=${res.bytesFreed}`,
    );
  }
}
