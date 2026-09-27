/**
 * AcpPermissionBroker — port of donor acp_permission_broker.py (a557df2).
 *
 * Decides agent-initiated `session/request_permission` requests against the
 * governed task envelope. It can only ever narrow authority, never widen it.
 * Unknown or escalating requests deny fail-closed. Approval selects the
 * least-privileged `allow_once` option — never a session-scoped grant.
 */

import path from "node:path";

const READ_CLASS_KINDS = new Set(["read", "search"]);
const WRITE_CLASS_KINDS = new Set(["edit", "delete", "move"]);
const EXECUTE_KINDS = new Set(["execute"]);
const NETWORK_KINDS = new Set(["fetch"]);
const ALWAYS_DENY_KINDS = new Set(["switch_mode"]);
const READ_CLASS_TITLES = ["read file", "list files", "search files"];

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface PermissionDecision {
  outcome: { outcome: string; optionId?: string };
  decision: {
    action: "ALLOW" | "DENY";
    request_class: string;
    reason_codes: string[];
    locations: string[];
  };
}

export class AcpPermissionBroker {
  constructor(private readonly envelope: Record<string, unknown>) {}

  private locations(toolCall: Record<string, unknown>): string[] {
    const locs = toolCall.locations ?? toolCall.locations;
    if (Array.isArray(locs)) return locs.map((l) => String(l));
    const raw = (toolCall.raw_input ?? toolCall.rawInput ?? {}) as Record<string, unknown>;
    const out: string[] = [];
    for (const k of ["path", "file", "file_path", "cwd", "target"]) {
      if (raw[k]) out.push(String(raw[k]));
    }
    return out;
  }

  private locationsContained(locations: string[]): { ok: boolean; escapes: string[] } {
    const workspace = String(this.envelope.workspace ?? "");
    const allowed = [
      ...new Set(
        [workspace, ...((this.envelope.allowed_paths as string[]) ?? [])].filter(Boolean),
      ),
    ];
    const escapes: string[] = [];
    if (!allowed.length) return { ok: false, escapes: locations.map(String) };
    for (const raw of locations) {
      const p = path.resolve(String(raw));
      if (!allowed.some((root) => within(p, path.resolve(root)))) escapes.push(String(raw));
    }
    return { ok: escapes.length === 0, escapes };
  }

  private classify(
    toolCall: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): { cls: string; reasons: string[] } {
    const kind = String(toolCall.kind ?? "");
    const name = String(toolCall.name ?? "");
    const rawInput = (toolCall.raw_input ?? toolCall.rawInput ?? {}) as Record<string, unknown>;
    const title = String(toolCall.title ?? "").trim().toLowerCase();
    const metaTitle = String(
      ((meta.permission as Record<string, unknown>) ?? {}).title ?? "",
    ).toLowerCase();

    if (name === "request_permissions" || "permissions" in rawInput || metaTitle.includes("grant")) {
      return { cls: "ESCALATION", reasons: ["ACP_PERMISSION_ESCALATION_REQUEST"] };
    }
    if (rawInput.url || title.includes("network access") || metaTitle.includes("network access")) {
      return { cls: "NETWORK", reasons: [] };
    }
    if (ALWAYS_DENY_KINDS.has(kind)) return { cls: "MODE_SWITCH", reasons: ["ACP_MODE_SWITCH_DENIED"] };
    if (NETWORK_KINDS.has(kind)) return { cls: "NETWORK", reasons: [] };
    if (WRITE_CLASS_KINDS.has(kind)) return { cls: "WRITE", reasons: [] };
    if (READ_CLASS_KINDS.has(kind)) return { cls: "READ", reasons: [] };
    if (EXECUTE_KINDS.has(kind)) {
      if (READ_CLASS_TITLES.some((p) => title.startsWith(p))) return { cls: "READ", reasons: [] };
      return { cls: "EXECUTE", reasons: [] };
    }
    if (kind === "think") return { cls: "READ", reasons: [] };
    return { cls: "ESCALATION", reasons: [`ACP_UNKNOWN_TOOL_KIND:${kind || "NONE"}`] };
  }

  private evaluate(cls: string, locations: string[], reasons: string[]): string[] {
    const permissions = new Set(((this.envelope.permissions as string[]) ?? []).map(String));
    const tools = new Set(((this.envelope.requested_tools as string[]) ?? []).map((t) => String(t).toUpperCase()));
    const constraints = new Set(((this.envelope.constraints as string[]) ?? []).map((c) => String(c).toUpperCase()));
    const { ok, escapes } = this.locationsContained(locations);
    const out = [...reasons];

    if (cls === "ESCALATION" || cls === "MODE_SWITCH") {
      out.push("ACP_PERMISSION_ENVELOPE_EXPANSION");
      return out;
    }
    if (cls === "NETWORK") {
      if (constraints.has("NO_NETWORK") || !permissions.has("NETWORK")) {
        out.push("ACP_NETWORK_NOT_GRANTED");
      }
    } else if (cls === "READ") {
      if (!permissions.has("READ") && !permissions.has("WRITE") && !permissions.has("FILE_READ") && !permissions.has("FILE_WRITE")) {
        out.push("ACP_READ_NOT_GRANTED");
      }
      if (locations.length && !ok) out.push(`ACP_PATH_OUTSIDE_ALLOWED_PATHS:${[...escapes].sort().join(",")}`);
    } else if (cls === "WRITE") {
      if (!permissions.has("WRITE") && !permissions.has("FILE_WRITE")) out.push("ACP_WRITE_NOT_GRANTED");
      if (locations.length && !ok) out.push(`ACP_PATH_OUTSIDE_ALLOWED_PATHS:${[...escapes].sort().join(",")}`);
      if (!locations.length) out.push("ACP_WRITE_TARGET_UNDECLARED");
    } else if (cls === "EXECUTE") {
      if (!tools.has("SHELL_EXECUTION")) out.push("ACP_TOOL_NOT_AUTHORIZED:SHELL_EXECUTION");
      if (locations.length && !ok) out.push(`ACP_PATH_OUTSIDE_ALLOWED_PATHS:${[...escapes].sort().join(",")}`);
    }
    return out;
  }

  private static selectOption(options: Array<Record<string, unknown>>): string | null {
    // Least privilege: prefer allow_once; never allow_always.
    for (const opt of options) {
      const kind = String(opt.kind ?? "");
      const id = String(opt.optionId ?? opt.option_id ?? "");
      if (kind === "allow_once" || kind === "allow_once_precise") return id || null;
    }
    for (const opt of options) {
      const kind = String(opt.kind ?? "");
      const id = String(opt.optionId ?? opt.option_id ?? "");
      if (kind.startsWith("allow")) return id || null;
    }
    for (const opt of options) {
      const id = String(opt.optionId ?? opt.option_id ?? "");
      if (id) return id;
    }
    return null;
  }

  /**
   * Decide one permission request. Returns the ACP response outcome plus the
   * structured PAIR decision record (persisted to permission_decisions.jsonl).
   */
  decide(
    toolCall: Record<string, unknown>,
    options: Array<Record<string, unknown>>,
    meta: Record<string, unknown>,
  ): PermissionDecision {
    const locations = this.locations(toolCall);
    const { cls, reasons } = this.classify(toolCall, meta);
    const codes = this.evaluate(cls, locations, reasons);
    const allowed = codes.length === 0;
    const decision: PermissionDecision["decision"] = {
      action: allowed ? "ALLOW" : "DENY",
      request_class: cls,
      reason_codes: codes,
      locations,
    };
    if (!allowed) {
      return { outcome: { outcome: "cancelled" }, decision };
    }
    const optionId = AcpPermissionBroker.selectOption(options);
    if (optionId == null) {
      decision.action = "DENY";
      decision.reason_codes = ["ACP_NO_ALLOW_OPTION"];
      return { outcome: { outcome: "cancelled" }, decision };
    }
    return { outcome: { outcome: "selected", optionId }, decision };
  }
}
