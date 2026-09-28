import { defineConfig } from "@playwright/test";

const PORT = 8790;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    // system Chrome on the Devin box (playwright's chrome channel looks in
    // /opt/google/chrome; use executablePath so the local install is found)
    launchOptions: { executablePath: process.env.CHROME_BIN ?? "/home/ubuntu/.local/bin/google-chrome" },
    colorScheme: "dark",
  },
  webServer: {
    command: "node ../../scripts/serve-mission-control.mjs",
    url: `http://localhost:${PORT}/api/health`,
    env: {
      PAIR_MC_PORT: String(PORT),
      PAIR_MC_DIR: "/tmp/pair-mc-e2e",
      PAIR_DSH_HOME: process.env.PAIR_DSH_HOME ?? "",
      CODEX_HOME: process.env.CODEX_HOME ?? "",
    },
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
