/**
 * Local Compute Client (automaton-pair fork)
 *
 * All operations execute on the local machine — there is no remote
 * control plane. Methods that have no local meaning (cloud sandbox
 * management, credit transfers, domain registration) return local
 * stand-ins or throw LocalUnavailableError.
 */

import { execSync } from "child_process";
import fs from "fs";
import nodePath from "path";
import type {
  ComputeClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";
import { STATIC_MODEL_BASELINE } from "../inference/types.js";
import { ulid } from "ulid";

export class LocalUnavailableError extends Error {
  constructor(feature: string) {
    super(`${feature} is unavailable in local mode (automaton-pair fork has no cloud control plane)`);
    this.name = "LocalUnavailableError";
  }
}

interface ComputeClientOptions {
  sandboxId?: string;
}

/**
 * Local credit budget, in cents. Defaults to a generous balance so the
 * runtime stays in the "high" survival tier. Operators can cap it via
 * the AUTOMATON_CREDITS_BALANCE env var (cents) to exercise survival
 * tiers, or via config/localBudgetCents.
 */
function localCreditsCents(): number {
  const raw = process.env.AUTOMATON_CREDITS_BALANCE;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1_000_000; // $10,000 — effectively unlimited
}

export function createComputeClient(options: ComputeClientOptions = {}): ComputeClient {
  const sandboxId = normalizeSandboxId(options.sandboxId);

  const execLocal = (command: string, timeout?: number): ExecResult => {
    try {
      const stdout = execSync(command, {
        timeout: timeout || 30_000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.env.HOME || "/root",
      });
      return { stdout: stdout || "", stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || err.message || "",
        exitCode: err.status ?? 1,
      };
    }
  };

  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => execLocal(command, timeout);

  const resolveLocalPath = (filePath: string): string =>
    filePath.startsWith("~")
      ? nodePath.join(process.env.HOME || "/root", filePath.slice(1))
      : filePath;

  const writeFile = async (filePath: string, content: string): Promise<void> => {
    const resolved = resolveLocalPath(filePath);
    const dir = nodePath.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
  };

  const readFile = async (filePath: string): Promise<string> =>
    fs.readFileSync(resolveLocalPath(filePath), "utf-8");

  const exposePort = async (port: number): Promise<PortInfo> => ({
    port,
    publicUrl: `http://localhost:${port}`,
    sandboxId: sandboxId || "local",
  });

  const removePort = async (_port: number): Promise<void> => {};

  // ─── Sandbox management: local stand-ins ─────────────────────

  const createSandbox = async (
    opts: CreateSandboxOptions,
  ): Promise<SandboxInfo> => ({
    id: `local-${ulid()}`,
    status: "running",
    region: "local",
    vcpu: opts.vcpu || 1,
    memoryMb: opts.memoryMb || 512,
    diskGb: opts.diskGb || 5,
    createdAt: new Date().toISOString(),
  });

  const deleteSandbox = async (_targetId: string): Promise<void> => {};

  const listSandboxes = async (): Promise<SandboxInfo[]> => [
    {
      id: sandboxId || "local",
      status: "running",
      region: "local",
      vcpu: 0,
      memoryMb: 0,
      diskGb: 0,
      createdAt: "",
    },
  ];

  // ─── Budget (replaces cloud credits) ─────────────────────────

  const getCreditsBalance = async (): Promise<number> => localCreditsCents();

  const getCreditsPricing = async (): Promise<PricingTier[]> => [];

  const transferCredits = async (
    _toAddress: string,
    _amountCents: number,
    _note?: string,
  ): Promise<CreditTransferResult> => {
    throw new LocalUnavailableError("Credit transfers");
  };

  const registerAutomaton = async (_params: {
    automatonId: string;
    automatonAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
    genesisPromptHash?: `0x${string}`;
    account: unknown;
    nonce?: string;
    chainType?: unknown;
    chainIdentity?: unknown;
  }): Promise<{ automaton: Record<string, unknown> }> => ({
    automaton: { id: _params.automatonId, registered: true, local: true },
  });

  // ─── Domains: no local equivalent ────────────────────────────

  const searchDomains = async (
    _query: string,
    _tlds?: string,
  ): Promise<DomainSearchResult[]> => {
    throw new LocalUnavailableError("Domain search");
  };

  const registerDomain = async (
    _domain: string,
    _years: number = 1,
  ): Promise<DomainRegistration> => {
    throw new LocalUnavailableError("Domain registration");
  };

  const listDnsRecords = async (_domain: string): Promise<DnsRecord[]> => {
    throw new LocalUnavailableError("DNS records");
  };

  const addDnsRecord = async (
    _domain: string,
    _type: string,
    _host: string,
    _value: string,
    _ttl?: number,
  ): Promise<DnsRecord> => {
    throw new LocalUnavailableError("DNS records");
  };

  const deleteDnsRecord = async (
    _domain: string,
    _recordId: string,
  ): Promise<void> => {
    throw new LocalUnavailableError("DNS records");
  };

  // ─── Model discovery: local registry baseline ────────────────

  const listModels = async (): Promise<ModelInfo[]> =>
    STATIC_MODEL_BASELINE.map((m) => ({
      id: m.modelId,
      provider: m.provider,
      pricing: {
        inputPerMillion: m.costPer1kInput * 1000,
        outputPerMillion: m.costPer1kOutput * 1000,
      },
    }));

  const createScopedClient = (targetSandboxId: string): ComputeClient =>
    createComputeClient({ sandboxId: targetSandboxId });

  const client: ComputeClient = {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    createSandbox,
    deleteSandbox,
    listSandboxes,
    getCreditsBalance,
    getCreditsPricing,
    transferCredits,
    registerAutomaton,
    searchDomains,
    registerDomain,
    listDnsRecords,
    addDnsRecord,
    deleteDnsRecord,
    listModels,
    createScopedClient,
  };

  return client;
}

function normalizeSandboxId(value: string | null | undefined): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  if (trimmed === "undefined" || trimmed === "null") return "";
  return trimmed;
}
