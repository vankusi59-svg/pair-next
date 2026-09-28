const BASE = "/api";

export function getOperatorId(): string {
  return localStorage.getItem("pair.operator_id") ?? "";
}

export function setOperatorId(id: string) {
  localStorage.setItem("pair.operator_id", id.trim());
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const op = getOperatorId();
  if (op) headers["x-operator-id"] = op;
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
  previewMission: (input: { project_id: string; goal: string; granted_permissions?: string[]; authorized_workspaces?: string[]; risk_ceiling?: string; metadata?: Record<string, unknown> }) =>
    req<{ plan: { tasks: Array<Record<string, unknown>> }; plan_digest: string; plan_source: string | null; plan_model: string | null }>("/missions/preview", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  startMission: (input: { project_id: string; goal: string; granted_permissions?: string[]; authorized_workspaces?: string[]; risk_ceiling?: string; confirm_plan?: { digest: string }; metadata?: Record<string, unknown> }) =>
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
};
