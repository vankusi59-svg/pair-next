/**
 * Per-test-file cleanup hook — runs inside every worker for every
 * test file via vitest `setupFiles`. Removes only dirs THIS worker
 * created through `mkTmpDir`; parallel workers each own their own
 * registry, so no cross-worker deletion can occur. Runs on failure
 * paths too (afterAll fires even when a test throws).
 */
import { afterAll } from "vitest";
import { cleanupTmpDirs } from "./tmpdir.js";

afterAll(() => {
  cleanupTmpDirs();
});
