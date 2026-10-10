const BASE = "/api";

export function getOperatorId(): string {
  return localStorage.getItem("pair.operator_id") ?? "";
}

export function setOperatorId(id: string) {
  localStorage.setItem("pair.operator_id", id.trim());
}

export function getAuthToken(): string {
  return localStorage.getItem("pair.mc_token") ?? "";
}

export function setAuthToken(tok: string) {
  localStorage.setItem("pair.mc_token", tok.trim());
}

export function withTokenQuery(url: string): string {
  const tok = getAuthToken();
  if (!tok) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok);
}

let lastTokenPromptAt = 0;

/* New /app/* surfaces may suppress the legacy 401 window.prompt + reload
   (audit R1-F2): they render their own Unauthorized state instead. The
   prompt behavior is unchanged for every other caller. */
async function req<T>(path: string, init?: RequestInit, opts?: { noAuthPrompt?: boolean }): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const op = getOperatorId();
  if (op) headers["x-operator-id"] = op;
  const tok = getAuthToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await r.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: "BAD_JSON", detail: text.slice(0, 300) };
  }
  if (!r.ok) {
    const e = body as { error?: string; detail?: string };
    if (r.status === 401 && !opts?.noAuthPrompt && Date.now() - lastTokenPromptAt > 5000) {
      lastTokenPromptAt = Date.now();
      const t = window.prompt("Mission Control access token:");
      if (t !== null) { setAuthToken(t); window.location.reload(); }
    }
    throw new ApiError(r.status, e.error ?? "ERROR", e.detail ?? "");
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export const api = {
  health: () => req<Record<string, unknown>>("/health"),
  metrics: () => req<Record<string, unknown>>("/metrics"),
  projects: () => req<Array<Record<string, unknown>>>("/projects"),
  missions: () => req<{ missions: import("./types").Mission[] }>("/missions"),
  missionDetail: (id: string) => req<import("./types").MissionDetail>(`/missions/${id}`),
  missionDag: (id: string) => req<import("./types").Dag>(`/missions/${id}/dag`),
  timeline: (id: string) => req<import("./types").TimelineEntry[]>(`/missions/${id}/timeline`),
  evidence: (id: string) => req<Array<Record<string, unknown>>>(`/missions/${id}/evidence`),
  routing: () => req<import("./types").RoutingProjection>("/routing"),
  providers: () => req<{ providers: Array<Record<string, unknown>>; qualifications: Array<Record<string, unknown>> }>("/providers"),
  models: () => req<{ models: Array<Record<string, unknown>>; bindings: Array<Record<string, unknown>>; qualifications: Array<Record<string, unknown>> }>("/models"),
  routes: () => req<{ routes: Array<Record<string, unknown>>; model_bindings: Array<Record<string, unknown>>; routable_models: Array<Record<string, unknown>>; route_decisions: Array<Record<string, unknown>>; routing_decisions: Array<Record<string, unknown>> }>("/routes"),
  recovery: () => req<Record<string, unknown>>("/recovery"),
  approvals: () => req<Array<Record<string, unknown>>>("/approvals"),
  /* /app/* surfaces suppress the legacy 401 prompt — same headers, same
     endpoint, only the auth-prompt UX differs (audit R1 residual). */
  approvalsNoPrompt: () =>
    req<Array<Record<string, unknown>>>("/approvals", undefined, { noAuthPrompt: true }),
  previewMission: (input: { project_id: string; goal: string; granted_permissions?: string[]; authorized_workspaces?: string[]; risk_ceiling?: string; metadata?: Record<string, unknown> }) =>
    req<{ plan: { tasks: Array<Record<string, unknown>> }; plan_digest: string; preview_id: string; plan_source: string | null; plan_model: string | null }>("/missions/preview", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  startMission: (input: { project_id: string; goal: string; granted_permissions?: string[]; authorized_workspaces?: string[]; risk_ceiling?: string; confirm_plan?: { digest: string; preview_id?: string }; metadata?: Record<string, unknown> }) =>
    req<Record<string, unknown>>("/missions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  missionAction: (id: string, action: "pause" | "resume" | "cancel" | "acknowledge") =>
    req<Record<string, unknown>>(`/missions/${id}/${action}`, { method: "POST", body: "{}" }),
  modelRoutable: (id: string) => req<{ model: Record<string, unknown> | null; bindings: Array<Record<string, unknown>> }>(`/models/${id}/routable`),
  missionFiles: (id: string) => req<{ files: Array<Record<string, unknown>> }>(`/missions/${id}/files`),
  missionFile: (id: string, p: string) =>
    req<{ path: string; content: string; size: number; truncated: boolean; sha256: string }>(
      `/missions/${id}/files?path=${encodeURIComponent(p)}`,
    ),
  schedules: () => req<{ schedules: Array<Record<string, unknown>> }>("/schedules"),
  cost: () => req<{ remote_dispatches_today: number; remote_daily_limit: number; cost_halt: boolean; schedules_active: number }>("/cost"),
  createSchedule: (input: { goal: string; cron: string; name?: string; project_id?: string }) =>
    req<Record<string, unknown>>("/schedules", { method: "POST", body: JSON.stringify(input) }),
  scheduleAction: (id: string, action: "enable" | "disable" | "delete") =>
    req<Record<string, unknown>>(`/schedules/${id}/${action}`, { method: "POST", body: "{}" }),
  approve: (id: string, scope: Record<string, unknown>, reason?: string) =>
    req<Record<string, unknown>>(`/approvals/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ reason: reason ?? "", scope }),
    }),
  deny: (id: string, scope: Record<string, unknown>, reason?: string) =>
    req<Record<string, unknown>>(`/approvals/${id}/deny`, {
      method: "POST",
      body: JSON.stringify({ reason: reason ?? "", scope }),
    }),
  businesses: () => req<{ businesses: Array<Record<string, unknown>> }>("/businesses"),
  // P15.7 — canonical vnext objectives (P15.1 authority)
  vnextObjectives: (businessId?: string) =>
    req<{ objectives: import("./types").CanonicalObjective[] }>(
      `/vnext/objectives${businessId ? `?business_id=${encodeURIComponent(businessId)}` : ""}`,
    ),
  vnextObjective: (id: string) => req<import("./types").CanonicalObjective>(`/vnext/objectives/${id}`),
  createVnextObjective: (input: import("./types").VnextObjectiveInput) =>
    req<import("./types").CanonicalObjective>("/vnext/objectives", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  runCeoCycle: (id: string) =>
    req<import("./types").OperatingPassResult>(`/vnext/objectives/${id}/ceo-cycle`, {
      method: "POST",
      body: "{}",
    }),
  // P15.9-A1 — owner-scoped company projection (non-owner → 403
  // FAIL_CLOSED_COMPANY_SCOPE; integrity → 500 FAIL_CLOSED_*)
  businessCompany: (id: string, signal?: AbortSignal) =>
    req<{ company: import("./app/types").CompanyPayload }>(
      `/vnext/businesses/${encodeURIComponent(id)}/company`,
      signal ? { signal } : undefined,
      { noAuthPrompt: true },
    ),
  // P15.10-A — objective auto-policy (owner-scoped; non-owner → 403)
  autoPolicyStatus: (id: string) =>
    req<{ auto_policy: import("./types").AutoPolicyStatus }>(
      `/vnext/objectives/${id}/auto-policy`,
    ),
  autoPolicyControl: (
    id: string,
    body: {
      action: string;
      policy_version?: number;
      limits?: import("./types").AutoPolicyStatus["limits"];
      idempotency_key: string;
      halt_reason?: string;
    },
  ) =>
    req<{ auto_policy: import("./types").AutoPolicyStatus }>(
      `/vnext/objectives/${id}/auto-policy`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  // ---- P15.8-D — conversation layer ----
  conversations: (state?: string) =>
    req<{ sessions: import("./types").ConversationSession[] }>(
      `/conversations${state ? `?state=${encodeURIComponent(state)}` : ""}`),
  createConversation: (input: { title?: string; client_request_id?: string }) =>
    req<{ session: import("./types").ConversationSession }>("/conversations", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  conversation: (id: string) =>
    req<{ session: import("./types").ConversationSession }>(`/conversations/${id}`),
  conversationMessages: (id: string, opts?: { after_seq?: number; limit?: number }) =>
    req<{ messages: import("./types").ConversationMessage[]; next_after_seq: number | null }>(
      `/conversations/${id}/messages${
        opts?.after_seq !== undefined || opts?.limit !== undefined
          ? `?${[
              opts.after_seq !== undefined ? `after_seq=${opts.after_seq}` : "",
              opts.limit !== undefined ? `limit=${opts.limit}` : "",
            ].filter(Boolean).join("&")}`
          : ""}`),
  conversationTurn: (id: string, input: { body: string; idempotency_key?: string }) =>
    req<import("./types").ConversationTurnResult>(`/conversations/${id}/turns`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  closeConversation: (id: string) =>
    req<{ session: import("./types").ConversationSession }>(`/conversations/${id}/close`, {
      method: "POST",
      body: "{}",
    }),
  conversationDrafts: (id: string) =>
    req<{ drafts: import("./types").MissionDraft[] }>(`/conversations/${id}/drafts`),
  createDraft: (id: string, input: {
    project_id: string;
    goal: string;
    granted_permissions?: string[];
    authorized_workspaces?: string[];
    risk_ceiling?: string;
    client_request_id?: string;
    supersedes_draft_id?: string;
  }) =>
    req<{ draft: import("./types").MissionDraft }>(`/conversations/${id}/drafts`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  confirmDraft: (id: string, draftId: string, expectedDigest: string) =>
    req<import("./types").DraftConfirmResult>(
      `/conversations/${id}/drafts/${draftId}/confirm`,
      { method: "POST", body: JSON.stringify({ expected_digest: expectedDigest }) }),
  rejectDraft: (id: string, draftId: string) =>
    req<{ draft: import("./types").MissionDraft }>(
      `/conversations/${id}/drafts/${draftId}/reject`,
      { method: "POST", body: "{}" }),
};
