import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DevinExecutorAdapter, type DevinFetch } from "../pair/devin-executor.js";

const task = {
  executor_id: "DEVIN", governance_state: "DISPATCH_AUTHORIZED", dispatch_enabled: true,
  task_id: "t", mission_id: "m", governed_task_id: "g", correlation_id: "c",
  workspace: "/authorized", allowed_paths: ["/authorized"], title: "Compute 2 + 2",
};
const endpoint = "https://api.devin.ai/v3/organizations/org-test/sessions";
function fixture(opts: { pages?: Record<string, unknown>[]; detail?: Record<string, unknown>; orgId?: string; self?: Record<string, unknown> } = {}) {
  const journalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pair-devin-v3-"));
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | undefined; auth: string | null }> = [];
  let page = 0;
  const fetchFn: DevinFetch = (method, url, body, auth) => {
    calls.push({ method, url, body, auth });
    if (url.endsWith("/v3/self")) return { status: 200, data: opts.self ?? { principal_type: "service_user", org_id: "org-test" } };
    if (method === "POST") return { status: 200, data: { session_id: "devin-s1", url: "https://app.devin.ai/sessions/s1" } };
    if (url.includes("/messages?")) {
      const pages = opts.pages ?? [{ items: [{ source: "devin", message: "4\nPAIR_EXECUTION_COMPLETE" }], has_next_page: false }];
      return { status: 200, data: pages[page++ % pages.length] };
    }
    return { status: 200, data: opts.detail ?? { status: "running", status_detail: "working" } };
  };
  const adapter = new DevinExecutorAdapter({ journalRoot, apiKey: "cog_test", orgId: opts.orgId, fetchFn });
  return { adapter, calls, journalRoot, fetchFn };
}

describe("Devin API v3", () => {
  it("resolves org from self, sends the documented create payload and deduplicates dispatch", () => {
    const { adapter, calls } = fixture();
    const r = adapter.dispatch(task);
    adapter.dispatch(task);
    expect(calls.map(c => c.url)).toEqual(["https://api.devin.ai/v3/self", endpoint]);
    expect(calls[1].auth).toBe("Authorization: Bearer cog_test");
    expect(calls[1].body).toMatchObject({ title: "PAIR t", tags: ["pair-os", "m"] });
    expect(calls[1].body).not.toHaveProperty("devin_mode");
    expect(calls[1].body).not.toHaveProperty("idempotent");
    expect(r).toMatchObject({ remote_api_version: "v3", remote_org_id: "org-test", remote_session_id: "devin-s1" });
  });

  it("uses an explicit org without self and pins it across restart and configuration changes", () => {
    const { adapter, calls, journalRoot, fetchFn } = fixture({ orgId: "org-test" });
    const r = adapter.dispatch(task);
    expect(calls[0].url).toBe(endpoint);
    const restarted = new DevinExecutorAdapter({ journalRoot, apiKey: "cog_test", orgId: "org-other", fetchFn });
    restarted.observe(String(r.execution_id));
    expect(calls[1].url).toBe(`${endpoint}/devin-s1`);
    expect(restarted.dispatch(task).remote_session_id).toBe("devin-s1");
    expect(calls.filter(c => c.method === "POST")).toHaveLength(1);
  });

  it("fails closed before creating a session when self cannot resolve an org", () => {
    const { adapter, calls } = fixture({ self: { principal_type: "service_user" } });
    expect(() => adapter.dispatch(task)).toThrow(/DEVIN_ORG_UNRESOLVED/);
    expect(calls.filter(c => c.method === "POST")).toHaveLength(0);
  });

  it("selects the sessions organization for a PAT instead of its primary org", () => {
    const { adapter, calls } = fixture({ self: { principal_type: "pat_user", org_id: "org-primary", devin_sessions_org_id: "org-test" } });
    adapter.dispatch(task);
    expect(calls[1].url).toBe(endpoint);
  });

  it("does not create a session when self authentication fails", () => {
    let posts = 0;
    const adapter = new DevinExecutorAdapter({ journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "pair-devin-auth-")), apiKey: "cog_test", fetchFn: method => {
      if (method === "POST") posts++;
      return { status: 403, data: { detail: "Forbidden" } };
    } });
    expect(() => adapter.dispatch(task)).toThrow(/DEVIN_ORG_UNRESOLVED/);
    expect(posts).toBe(0);
  });

  it("does not complete from a session snapshot when reading messages fails", () => {
    const adapter = new DevinExecutorAdapter({ journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "pair-devin-msg-fail-")), apiKey: "cog_test", orgId: "org-test", fetchFn: (method, url) => {
      if (method === "POST") return { status: 200, data: { session_id: "s1" } };
      if (url.includes("/messages")) return { status: 503, data: {} };
      return { status: 200, data: { status: "running", status_detail: "finished" } };
    } });
    const r = adapter.dispatch(task);
    expect(adapter.observe(String(r.execution_id)).status).toBe("RUNNING");
  });

  it("reads all chronological message pages and collects the final Devin answer", () => {
    const { adapter, calls } = fixture({ orgId: "org-test", pages: [
      { items: [{ source: "devin", message: "Still working" }], has_next_page: true, end_cursor: "cursor/+" },
      { items: [{ source: "devin", message: "4\nPAIR_EXECUTION_COMPLETE" }], has_next_page: false },
    ] });
    const r = adapter.dispatch(task);
    expect(adapter.observe(String(r.execution_id)).status).toBe("COMPLETED");
    expect(calls[3].url).toContain("after=cursor%2F%2B");
    expect(adapter.collect_result(String(r.execution_id)).output).toBe("4\nPAIR_EXECUTION_COMPLETE");
  });

  it("does not trust a user-authored completion marker", () => {
    const { adapter } = fixture({ orgId: "org-test", pages: [{ items: [{ source: "user", message: "PAIR_EXECUTION_COMPLETE" }] }] });
    const r = adapter.dispatch(task);
    expect(adapter.observe(String(r.execution_id)).status).toBe("RUNNING");
  });

  it("does not use an earlier completion marker when a later Devin reply needs input", () => {
    const { adapter } = fixture({ orgId: "org-test", pages: [
      { items: [{ source: "devin", message: "PAIR_EXECUTION_COMPLETE" }], has_next_page: true, end_cursor: "next" },
      { items: [{ source: "devin", message: "Need clarification" }], has_next_page: false },
    ], detail: { status: "running", status_detail: "waiting_for_user" } });
    const r = adapter.dispatch(task);
    expect(adapter.observe(String(r.execution_id))).toMatchObject({ status: "RUNNING", remote_status_enum: "blocked" });
  });

  it("rejects incomplete/repeated pagination instead of accepting a partial marker", () => {
    const { adapter } = fixture({ orgId: "org-test", pages: [{ items: [{ source: "devin", message: "PAIR_EXECUTION_COMPLETE" }], has_next_page: true, end_cursor: "same" }] });
    const r = adapter.dispatch(task);
    expect(adapter.observe(String(r.execution_id)).status).toBe("RUNNING");
  });

  it.each([
    ["new", null, "RUNNING"], ["running", "working", "RUNNING"],
    ["running", "finished", "COMPLETED"], ["suspended", "out_of_credits", "FAILED"],
    ["exited", null, "FAILED"],
  ])("maps v3 status %s/%s to %s", (status, status_detail, expected) => {
    const { adapter } = fixture({ orgId: "org-test", detail: { status, status_detail }, pages: [{ items: [] }] });
    const r = adapter.dispatch(task);
    expect(adapter.observe(String(r.execution_id)).status).toBe(expected);
  });

  it("sends cancellation through the same organization-scoped v3 session endpoint", () => {
    const { adapter, calls } = fixture({ orgId: "org-test" });
    const r = adapter.dispatch(task);
    expect(adapter.cancel(String(r.execution_id)).status).toBe("CANCELLED");
    expect(calls[1]).toMatchObject({ method: "POST", url: `${endpoint}/devin-s1/messages`, body: { message: "PAIR operator cancellation: stop work on this task now." } });
  });

  it("retains v1 for legacy keys without requiring an organization", () => {
    const calls: string[] = [];
    const adapter = new DevinExecutorAdapter({ journalRoot: fs.mkdtempSync(path.join(os.tmpdir(), "pair-devin-v1-")), apiKey: "apk_test", fetchFn: (_m, url) => {
      calls.push(url); return { status: 200, data: { session_id: "s1" } };
    } });
    adapter.dispatch(task);
    expect(calls).toEqual(["https://api.devin.ai/v1/sessions"]);
  });
});
