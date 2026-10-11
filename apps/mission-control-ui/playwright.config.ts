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
      // P15.8-D — e2e never calls a real/paid model: deterministic
      // conversation replies come from the server's test-only stub seam.
      PAIR_CONVERSATION_STUB_REPLY:
        "PAIR trả lời mô phỏng: đây là phản hồi thử nghiệm.",
      // Same reason: e2e has no qualified LLM provider — the governed
      // preview/confirm path still runs, plans come from the template.
      PAIR_MC_TEMPLATE_PLANNER: "1",
    },
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
