import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import type { AgentContractPolicy, OrgAgentRow, WorkItemRow } from "../types";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton } from "../components/states";

/* P15.9-B5.1 — AI Workforce overview (D.5/E.4).
   AUTHORITY CONTRACT (mandate §3): GET /api/org-agents is an
   UNFILTERED global collection — server-side business filtering is
   API_MISSING. This page filters rows client-side by
   `agent.business_id === selected business`, discloses how many rows
   were hidden, and NEVER describes that as server-side authorization
   or owner-scoped enumeration. The owner-scoped company projection is
   fetched to VERIFY the selected-business context (403 → context
   unverified banner — never implied ownership). */

const TERMINAL = new Set(["DONE", "CANCELLED"]);
const AGENT_TONE: Record<string, Tone> = { ACTIVE: "ok", PAUSED: "warn", TERMINATED: "unknown" };

type AgentExtras = {
  /* tri-state: canonical row | successful read returning null |
     failed read — a failed GET is NEVER rendered as not-materialized */
  contract:
    | { kind: "row"; status: string; version: number | null }
    | { kind: "none" }
    | { kind: "unavailable"; code: string };
  policyLine: string | null;
  /* corrupt receipts / malformed payloads make any exact pending count
     UNPROVEN — render indeterminate, never a fabricated exact number */
  inbox:
    | { kind: "count"; n: number }
    | { kind: "corrupt"; corrupt: number }
    | { kind: "malformed" }
    | { kind: "unavailable"; code: string };
  failedReads: string[];
};

type St =
  | { kind: "no-business" }
  | { kind: "loading" }
  | {
      kind: "ready";
      forBiz: string;
      agents: OrgAgentRow[]; /* already filtered to forBiz */
      filteredOut: number;
      items: WorkItemRow[] | null; /* null = read failed → workload unavailable */
      context: "verified" | "unverified";
      contextCode: string | null;
      contextStatus: number | null;
      extras: Record<string, AgentExtras>;
    }
  | { kind: "error"; err: ApiError };

function policyLine(p: AgentContractPolicy | undefined): string {
  if (!p) return "unavailable";
  const allowed = p.allowed_capabilities;
  const denied = Array.isArray(p.denied_capabilities) ? p.denied_capabilities.length : 0;
  const ex = p.allowed_executor_ids;
  const caps = allowed === null ? "unrestricted capabilities" : `caps: ${allowed.join(", ") || "none"}`;
  const execs = ex === null ? "any executor" : `executors: ${ex.length} allowed`;
  return `${caps} · ${execs} · ${denied} denied`;
}

export function Workforce() {
  const { biz } = useSelectedBusiness();
  const [st, setSt] = useState<St>({ kind: "loading" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setSt(biz ? { kind: "loading" } : { kind: "no-business" });
    if (!biz) return;
    const ctl = new AbortController();
    const forBiz = biz;
    (async () => {
      const [companyR, agentsR, itemsR] = await Promise.allSettled([
        api.businessCompany(forBiz, ctl.signal),
        api.orgAgents(ctl.signal),
        api.workItems(forBiz, ctl.signal),
      ]);
      if (ctl.signal.aborted) return;
      if (agentsR.status === "rejected") {
        const e = agentsR.reason;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
        return;
      }
      const all = Array.isArray(agentsR.value.agents) ? agentsR.value.agents : [];
      const agents = all.filter((a) => a.business_id === forBiz);
      const context: "verified" | "unverified" =
        companyR.status === "fulfilled" && String(companyR.value.company.business.business_id) === forBiz
          ? "verified"
          : "unverified";
      const contextCode =
        companyR.status === "rejected"
          ? (companyR.reason instanceof ApiError ? companyR.reason.code : "ERROR")
          : null;
      const contextStatus =
        companyR.status === "rejected" && companyR.reason instanceof ApiError
          ? companyR.reason.status
          : null;
      const items = itemsR.status === "fulfilled" && Array.isArray(itemsR.value.work_items)
        ? itemsR.value.work_items
        : null;
      /* Per-agent canonical detail reads — bounded by the filtered
         (this-business) agent count, never the global list. Each read
         settles independently: a failure marks THAT field unavailable,
         never zero/unrestricted. */
      const extras: Record<string, AgentExtras> = {};
      await Promise.all(agents.map(async (a) => {
        const id = String(a.agent_id);
        const failedReads: string[] = [];
        const [c, p, i] = await Promise.allSettled([
          api.agentContract(id, ctl.signal),
          api.agentEffectivePolicy(id, ctl.signal),
          api.agentInbox(id, ctl.signal),
        ]);
        if (ctl.signal.aborted) return;
        const contract: AgentExtras["contract"] =
          c.status === "rejected"
            ? { kind: "unavailable", code: c.reason instanceof ApiError ? c.reason.code : "ERROR" }
            : c.value.contract
              ? { kind: "row", status: String(c.value.contract.status), version: Number(c.value.contract.contract_version) }
              : { kind: "none" };
        if (c.status === "rejected") failedReads.push("contract");
        const policyTxt = p.status === "fulfilled" ? policyLine(p.value.policy) : null;
        if (p.status === "rejected") failedReads.push("effective-policy");
        const inbox: AgentExtras["inbox"] = (() => {
          if (i.status === "rejected")
            return { kind: "unavailable" as const, code: i.reason instanceof ApiError ? i.reason.code : "ERROR" };
          const msgs = i.value.messages;
          if (!Array.isArray(msgs)) return { kind: "malformed" as const };
          const corrupt = msgs.filter(
            (m) => m.corrupt || m.state === "CORRUPT" || m.receipt_status === "CORRUPT",
          ).length;
          if (corrupt > 0) return { kind: "corrupt" as const, corrupt };
          return { kind: "count" as const, n: msgs.filter((m) => m.receipt_status === "PENDING").length };
        })();
        if (i.status === "rejected") failedReads.push("inbox");
        extras[id] = {
          contract,
          policyLine: policyTxt,
          inbox,
          failedReads,
        };
      }));
      if (ctl.signal.aborted) return;
      setSt({
        kind: "ready",
        forBiz,
        agents,
        filteredOut: all.length - agents.length,
        items,
        context,
        contextCode,
        contextStatus,
        extras,
      });
    })();
    return () => ctl.abort();
  }, [biz, tick]);

  const retry = () => setTick((n) => n + 1);

  if (st.kind === "no-business") {
    return (
      <>
        <h1>AI Workforce</h1>
        <div className="sub">Agents of one business — contracts, policy, workload, inbox.</div>
        <EmptyState
          title="No business selected"
          detail="Enter a business_id in the switcher — agents are filtered to the selected business from a global unfiltered read."
        />
      </>
    );
  }
  if (st.kind === "loading" || (st.kind === "ready" && st.forBiz !== biz)) {
    /* synchronous render guard: a ready state for another business
       never paints under the current one */
    return (
      <>
        <h1>AI Workforce</h1>
        <div className="sub">Loading {biz}…</div>
        <div className="ecards">
          {[0, 1].map((i) => (
            <div className="ecard" key={i} style={{ cursor: "default" }}>
              <Skeleton height={14} width="55%" />
              <Skeleton height={11} width="35%" />
              <Skeleton height={26} />
            </div>
          ))}
        </div>
      </>
    );
  }
  if (st.kind === "error") {
    const { err } = st;
    return (
      <>
        <h1>AI Workforce</h1>
        <div className="sub">{biz}</div>
        {err.status === 401 ? (
          <ErrorState
            code={err.code || "UNAUTHORIZED"}
            detail={`Your credentials were rejected — update the session token in Settings, then retry. ${err.detail}`}
            onRetry={retry}
          />
        ) : err.status === 403 ? (
          <DeniedState detail={`Agent list denied: ${err.detail} (${err.code})`} />
        ) : (
          <ErrorState
            code={err.code}
            detail={
              err.code.startsWith("FAIL_CLOSED")
                ? `Integrity check failed — the server refused to return possibly-corrupt data. ${err.detail}`
                : err.detail
            }
            onRetry={retry}
          />
        )}
      </>
    );
  }

  /* Render-time client filter — the authoritative rule: only rows whose
     business_id matches the CURRENT selected business may paint. */
  const agents = st.agents.filter((a) => a.business_id === biz);
  const items = st.items;
  const workload = (agentId: string) =>
    items === null ? null : items.filter((w) => w.assignee_agent_id === agentId && !TERMINAL.has(w.status));

  return (
    <>
      <div className="chead">
        <div>
          <h1>AI Workforce</h1>
          <div className="sub">{biz} — agents, contracts, workload, inbox</div>
        </div>
      </div>

      {st.context === "unverified" ? (
        <div className="trunc" role="alert">
          Selected-business owner context unverified
          {st.contextStatus ? ` (${st.contextStatus}${st.contextCode ? ` ${st.contextCode}` : ""})` : ""}
          — the agent list below is the GLOBAL unfiltered read filtered
          client-side by business_id, never an owner-scoped enumeration.
        </div>
      ) : null}

      <div className="sub srcnote" style={{ marginBottom: 10 }}>
        Agent list source: <code>GET /api/org-agents</code> — global, unfiltered.
        Showing {agents.length} agent(s) whose business_id matches the selected business;
        {st.filteredOut > 0 ? ` ${st.filteredOut} row(s) hidden (other businesses). ` : " "}
        Client-side filter — NOT server-side authorization (server filter: API_MISSING).
      </div>

      {items === null ? (
        <div className="trunc" role="alert">
          Work-item read failed — workload counts are unavailable (never read as zero). Agent cards still render.
        </div>
      ) : null}

      {agents.length === 0 ? (
        <EmptyState
          title="No agents in this business"
          detail="No global org-agent row carries this business_id. Agent creation admin is deferred to B5.2."
        />
      ) : (
        <div className="ecards">
          {agents.map((a) => {
            const id = String(a.agent_id);
            const ex = st.extras[id];
            const load = workload(id);
            return (
              <div className="ecard" key={id}>
                <div className="eh">
                  <div>
                    <div className="t">{a.title || id}</div>
                    <div className="oid">{id}</div>
                  </div>
                  <StatusBadge tone={AGENT_TONE[a.status] ?? "unknown"} label={a.status} />
                </div>
                <div className="efoot">
                  <span>dept {a.department || "—"}</span>
                  {a.role ? <span>role {a.role}</span> : null}
                  {a.executor_binding ? <span>executor <code>{a.executor_binding}</code></span> : null}
                  {a.reports_to ? <span>reports to <code>{String(a.reports_to).slice(0, 16)}</code></span> : null}
                </div>
                <div className="efoot">
                  <span>
                    contract{" "}
                    {!ex ? (
                      <span className="note">—</span>
                    ) : ex.contract.kind === "row" ? (
                      <>
                        <code>{ex.contract.status}</code>
                        {ex.contract.version !== null ? ` v${ex.contract.version}` : ""}
                      </>
                    ) : ex.contract.kind === "none" ? (
                      <span className="note">not materialized</span>
                    ) : (
                      <span className="note">unavailable ({ex.contract.code})</span>
                    )}
                  </span>
                  <span>workload {load === null ? "—" : `${load.length} active`}</span>
                  <span>
                    inbox{" "}
                    {!ex ? (
                      "—"
                    ) : ex.inbox.kind === "count" ? (
                      `${ex.inbox.n} pending`
                    ) : ex.inbox.kind === "corrupt" ? (
                      <span className="note">
                        indeterminate — {ex.inbox.corrupt} corrupt receipt(s), pending count unproven
                      </span>
                    ) : ex.inbox.kind === "malformed" ? (
                      <span className="note">unavailable (malformed payload)</span>
                    ) : (
                      <span className="note">unavailable ({ex.inbox.code})</span>
                    )}
                  </span>
                </div>
                <div className="efoot">
                  <span>policy: {ex?.policyLine ?? "unavailable — not unrestricted"}</span>
                  {ex && ex.failedReads.length > 0 ? <span>failed reads: {ex.failedReads.join(", ")}</span> : null}
                </div>
                <div className="efoot">
                  <Link className="go" to={`/app/workforce/${encodeURIComponent(id)}`}>open agent →</Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
