import { defineConfig } from "@playwright/test";

/* Personal Mode E2E (PAIR_PERSONAL_MODE=local): the webServer boots the
   real serve script with the session lane on PAIR_MC_PORT and the
   bearer-only remote ingress on PAIR_MC_REMOTE_PORT. The UI build must
   exist (pnpm build) — the server serves apps/mission-control-ui/dist.
   Runs the dedicated spec only; the default config's specs keep their
   legacy bearer environment untouched. */
const PORT = 8792;
const REMOTE_PORT = 8793;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "personal-mode.spec.ts",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Windows dev box: Edge is present; CHROME_BIN can override.
    launchOptions: process.env.CHROME_BIN
      ? { executablePath: process.env.CHROME_BIN }
      : {},
    channel: process.env.CHROME_BIN ? undefined : "msedge",
    colorScheme: "dark",
  },
  webServer: {
    command: "node ../../scripts/serve-mission-control.mjs",
    url: `http://localhost:${PORT}/api/health`,
    env: {
      PAIR_PERSONAL_MODE: "local",
      PAIR_MC_PORT: String(PORT),
      PAIR_MC_REMOTE_PORT: String(REMOTE_PORT),
      PAIR_MC_DIR: "/tmp/pair-mc-e2e-personal",
      PAIR_DSH_HOME: process.env.PAIR_DSH_HOME ?? "",
      CODEX_HOME: process.env.CODEX_HOME ?? "",
      PAIR_CONVERSATION_STUB_REPLY:
        "PAIR trả lời mô phỏng: đây là phản hồi thử nghiệm.",
      PAIR_MC_TEMPLATE_PLANNER: "1",
    },
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
