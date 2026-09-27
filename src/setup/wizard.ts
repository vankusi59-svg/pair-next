import path from "path";
import fs from "fs";
import chalk from "chalk";
import type { AutomatonConfig, TreasuryPolicy } from "../types.js";
import { DEFAULT_TREASURY_POLICY, DEFAULT_CONFIG } from "../types.js";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { createConfig, saveConfig } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { showBanner } from "./banner.js";
import {
  promptRequired,
  promptMultiline,
  promptAddress,
  promptOptional,
  promptWithDefault,
  closePrompts,
} from "./prompts.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";
import type { ChainType } from "../identity/chain.js";

export async function runSetupWizard(): Promise<AutomatonConfig> {
  showBanner();

  console.log(chalk.white("  First-run setup (automaton-pair fork). Let's bring your automaton to life.\n"));

  // ─── 1. Identity (local wallet) ───────────────────────────────
  console.log(chalk.cyan("  [1/6] Identity (local wallet)..."));
  let selectedChain: ChainType = "evm";
  const chainInput = await promptOptional("Chain type (evm or solana) [evm]");
  if (chainInput && chainInput.toLowerCase() === "solana") {
    selectedChain = "solana";
    console.log(chalk.green("  Chain: Solana (Ed25519)\n"));
  } else {
    console.log(chalk.green("  Chain: EVM (secp256k1)\n"));
  }

  const { chainIdentity, chainType: walletChainType, isNew } = await getWallet(selectedChain);
  const walletAddress = chainIdentity.address;
  if (isNew) {
    console.log(chalk.green(`  Wallet created: ${walletAddress}`));
  } else {
    console.log(chalk.green(`  Wallet loaded: ${walletAddress}`));
  }
  console.log(chalk.dim(`  Private key stored at: ${getAutomatonDir()}/wallet.json`));
  console.log(chalk.dim("  (local credential only — no cloud account, no on-chain role)\n"));

  // ─── 2. Inference provider keys ───────────────────────────────
  console.log(chalk.cyan("  [2/6] Inference providers"));
  console.log(chalk.white("  Enter API keys for the providers you want (press Enter to skip)."));
  console.log(chalk.dim("  Keys may already be set via env vars: OPENAI_API_KEY, GROQ_API_KEY,"));
  console.log(chalk.dim("  GEMINI_API_KEY, AGNES_API_KEY, TOGETHER_API_KEY, ANTHROPIC_API_KEY.\n"));

  const openaiApiKey = await promptOptional("OpenAI API key (sk-..., optional)");
  const anthropicApiKey = await promptOptional("Anthropic API key (sk-ant-..., optional)");
  const ollamaInput = await promptOptional("Ollama base URL (http://localhost:11434, optional)");
  const ollamaBaseUrl = ollamaInput || undefined;

  const envProviders = ["GROQ_API_KEY", "GEMINI_API_KEY", "AGNES_API_KEY", "TOGETHER_API_KEY"]
    .filter((k) => !!process.env[k]);
  if (envProviders.length > 0) {
    console.log(chalk.green(`  Detected env keys: ${envProviders.join(", ")}\n`));
  }
  if (!openaiApiKey && !anthropicApiKey && !ollamaBaseUrl && envProviders.length === 0) {
    console.log(chalk.yellow("  No provider keys found — the agent will not be able to run inference.\n"));
  }

  // ─── 3. Identity questions ────────────────────────────────────
  console.log(chalk.cyan("  [3/6] Setup questions\n"));

  const name = await promptRequired("What do you want to name your automaton?");
  console.log(chalk.green(`  Name: ${name}\n`));

  const genesisPrompt = await promptMultiline("Enter the genesis prompt (system prompt) for your automaton.");
  console.log(chalk.green(`  Genesis prompt set (${genesisPrompt.length} chars)\n`));

  const creatorAddress = await promptAddress("Creator address (0x... or any identifier)", walletChainType);
  console.log(chalk.green(`  Creator: ${creatorAddress}\n`));

  // ─── Budget policy ────────────────────────────────────────────
  console.log(chalk.cyan("  Budget policy"));
  console.log(chalk.dim("  These limits protect against runaway inference spend. Press Enter for defaults.\n"));

  const treasuryPolicy: TreasuryPolicy = {
    ...DEFAULT_TREASURY_POLICY,
    maxInferenceDailyCents: await promptWithDefault(
      "Max daily inference spend (cents)", DEFAULT_TREASURY_POLICY.maxInferenceDailyCents),
    requireConfirmationAboveCents: await promptWithDefault(
      "Require confirmation above (cents)", DEFAULT_TREASURY_POLICY.requireConfirmationAboveCents),
  };

  const localBudgetCents = await promptWithDefault(
    "Local inference budget (cents — the number check_credits reports)",
    DEFAULT_CONFIG.localBudgetCents ?? 1_000_000,
  );
  console.log(chalk.green("  Budget configured.\n"));

  // ─── 4. Environment detection ─────────────────────────────────
  console.log(chalk.cyan("  [4/6] Detecting environment..."));
  const env = detectEnvironment();
  console.log(chalk.dim(`  Environment: ${env.type}\n`));

  // ─── 5. Write config + heartbeat + SOUL.md + skills ───────────
  console.log(chalk.cyan("  [5/6] Writing configuration..."));

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress,
    sandboxId: "",
    walletAddress,
    openaiApiKey: openaiApiKey || undefined,
    anthropicApiKey: anthropicApiKey || undefined,
    ollamaBaseUrl,
    treasuryPolicy,
    chainType: walletChainType,
    localBudgetCents,
  });

  saveConfig(config);
  console.log(chalk.green("  automaton.json written"));

  writeDefaultHeartbeatConfig();
  console.log(chalk.green("  heartbeat.yml written"));

  // constitution.md (immutable — copied from repo, protected from self-modification)
  const automatonDir = getAutomatonDir();
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSrc)) {
    fs.copyFileSync(constitutionSrc, constitutionDst);
    fs.chmodSync(constitutionDst, 0o444); // read-only
    console.log(chalk.green("  constitution.md installed (read-only)"));
  }

  // SOUL.md
  const soulPath = path.join(automatonDir, "SOUL.md");
  fs.writeFileSync(soulPath, generateSoulMd(name, walletAddress, creatorAddress, genesisPrompt), { mode: 0o600 });
  console.log(chalk.green("  SOUL.md written"));

  // Default skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  installDefaultSkills(skillsDir);
  console.log(chalk.green("  Default skills installed\n"));

  // ─── 6. Summary ───────────────────────────────────────────────
  console.log(chalk.cyan("  [6/6] Ready\n"));
  showSummaryPanel(name, localBudgetCents);

  closePrompts();

  return config;
}

function showSummaryPanel(name: string, budgetCents: number): void {
  const w = 58;
  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));

  console.log(chalk.cyan(`  ${"╭" + "─".repeat(w) + "╮"}`));
  console.log(chalk.cyan(`  │${pad(`  ${name} is configured`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Inference budget: ${budgetCents} cents`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  Start with:  node dist/index.js --run", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  The survival system handles zero-budget gracefully.", w)}│`));
  console.log(chalk.cyan(`  ${"╰" + "─".repeat(w) + "╯"}`));
  console.log("");
}
