import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { useSelectedBusiness } from "../AppShell";
import type { CockpitPayload } from "../types";
import type { AutoDriverStatus, AutoPolicyStatus, AutoSchedulerStatus } from "../../types";
import { ObjectiveAutonomousLoop } from "../components/ObjectiveAutonomousLoop";
import type { EpRead, LoopInputs } from "../lib/objectiveLoop";
import { epError, epMissing, epReady, pollGate, shouldApplyResponse } from "../lib/objectiveLoop";
import { StatusBadge, ProofChip, type Tone } from "../components/StatusBadge";
import { DeniedState, EmptyState, ErrorState, Skeleton, UnverifiedPanel } from "../components/states";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { money } from "../components/EntityCard";

/* P15.9-B3 — Objective Detail (mandate §4/§5): canonical read
   GET /api/vnext/objectives/:id/cockpit only. Fresh pending =
   lifecycle.owner_action_required ONLY; CANDIDATE ≠ ACHIEVED;
   observation_error → UnverifiedPanel; *_microusd always USD. */

type LoadState =
  | { kind: "no-business" }
  | { kind: "loading" }
  | { kind: "ready"; data: CockpitPayload; forBiz: string; forId: string }
  | { kind: "mismatch"; objBiz: string }
  | { kind: "error"; err: ApiError };

const S_TONE: Record<string, Tone> = {
  DRAFT: "unknown", PROPOSED: "info", RUNNING: "info", PAUSED: "warn",
  ACHIEVED: "ok", CANCELLED: "unknown", FAILED: "danger", EXPIRED: "warn",
  TARGET_MET_CANDIDATE: "purple", MET: "ok", GAP: "warn", UNVERIFIED: "unknown",
  DONE: "ok", COMPLETED: "ok", IN_PROGRESS: "info", BACKLOG: "unknown",
  ENABLED: "ok", DISABLED: "unknown", PAUSED_P: "warn", HALTED: "danger",
  REVOKED: "danger",
  EXPIRED_P: "warn", ACTIVE: "ok", INTERVENTION: "warn", EXHAUSTED: "danger",
};

/* Legal auto-policy transitions mirrored from
   objective-auto-policy.ts TRANSITIONS — controls only appear for
   states the backend accepts; every action still re-validates
   server-side (CAS on policy_version). */
const POLICY_TRANSITIONS: Record<string, string[]> = {
  configure: ["DISABLED", "EXPIRED"],
  enable: ["DISABLED", "PAUSED"],
  pause: ["ENABLED"],
  resume: ["PAUSED"],
  disable: ["ENABLED", "PAUSED", "HALTED"],
  revoke: ["ENABLED", "PAUSED", "DISABLED", "HALTED"],
  halt: ["ENABLED", "PAUSED"],
  reset_halt: ["HALTED"],
};
const POLICY_LABELS: Record<string, string> = {
  configure: "Configure policy", enable: "Enable policy", pause: "Pause policy",
  resume: "Resume policy", disable: "Disable policy", revoke: "Revoke policy",
  halt: "Halt policy (objective scope)", reset_halt: "Reset halt",
};

type DlgCtx =
  | { kind: "ceo"; biz: string; oid: string }
  | { kind: "policy"; action: string; biz: string; oid: string; policyVersion: number | null }
  | { kind: "measure" | "evidence" | "amend" | "kpi-grant"; biz: string; oid: string }
  | { kind: "kpi-control"; action: "revoke" | "disable"; biz: string; oid: string; authorization_id: string };

export function ObjectiveDetail() {
  const { id = "" } = useParams();
  const { biz } = useSelectedBusiness();
  const [st, setSt] = useState<LoadState>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [dlg, setDlg] = useState<DlgCtx | null>(null);
  const [mutBusy, setMutBusy] = useState(false);
  const [mutNote, setMutNote] = useState<string | null>(null);
  /* Canonical auto-policy control state — fetched via the dedicated
     GET (not the cockpit snapshot) and refreshed every 5s while the
     page is visible; each new tick aborts the previous request so a
     stale response can never overwrite a fresher one. */
  const [polSt, setPolSt] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: AutoPolicyStatus; forId: string; atMs: number }
    | { kind: "error"; err: ApiError }
  >({ kind: "loading" });
  const [polTick, setPolTick] = useState(0);
  /* Autonomous-loop observability reads — same 5s poll cadence, same
     abort/newest-wins and fail-closed identity conventions as the
     auto-policy read. atMs guards out-of-order responses even if an
     abort lands late. */
  const [schSt, setSchSt] = useState<EpRead<AutoSchedulerStatus>>({ kind: "missing" });
  const [drvSt, setDrvSt] = useState<EpRead<AutoDriverStatus>>({ kind: "missing" });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const cptAt = useRef<number | null>(null);
  const lastApplied = useRef({ sch: 0, drv: 0, pol: 0 });
  /* Exact-body retry store: the submitted mutation body is kept
     verbatim (action, policy_version, limits, halt params,
     idempotency key) keyed by operation signature. An ambiguous
     transport failure retries the identical bytes; a definitive CAS
     conflict or a committed result discards the stored op so the next
     confirmation mints a fresh operation. */
  const pendingOps = useRef<Record<string, Parameters<typeof api.autoPolicyControlApp>[1]>>({});
  /* Latest pending Configure op for THIS objective: lets a reopened
     dialog restore the originally submitted limits instead of
     resetting to defaults. Superseded only when the owner confirms a
     genuinely different configure body — an explicit new operation. */
  const pendingCfg = useRef<{ oid: string; sig: string } | null>(null);
  const [polPending, setPolPending] = useState<string | null>(null);
  /* Monotonic op token: a resolution whose token is no longer current
     (dialog context invalidated by navigation) never touches this
     view's state — the committed backend mutation stands, but this
     surface does not show it as belonging to a different identity. */
  const opSeq = useRef(0);
  const [polLimits, setPolLimits] = useState({ expires: "", ceo: "", missions: "", budget: "" });
  /* P15.9 Step-0 — owner measurement / evidence / amend / KPI-grant
     operations. Same idempotent contract as the policy ops: the
     submitted body (evidence_key / idempotency_key) is minted once per
     operation signature and replayed verbatim on retry; a definitive
     409 conflict or committed result discards it. */
  const ownerOps = useRef<Record<string, Record<string, unknown>>>({});
  const [meas, setMeas] = useState({ kpi: "", value: "", note: "" });
  const [evNote, setEvNote] = useState("");
  const [amend, setAmend] = useState({ title: "", deadline: "", budget: "", reason: "" });
  const [grantF, setGrantF] = useState({ kpi: "", count: "", keys: "", value: "", expires: "" });
  const [grTick, setGrTick] = useState(0);
  const [grSt, setGrSt] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: Record<string, unknown> }
    | { kind: "error"; err: ApiError }
  >({ kind: "loading" });

  // Cross-objective isolation: switching objective or business drops
  // any pending dialog, note, and in-flight result ownership.
  useEffect(() => {
    setMutNote(null);
    setDlg(null);
    setMutBusy(false);
    setPolSt({ kind: "loading" });
    setSchSt({ kind: "missing" });
    setDrvSt({ kind: "missing" });
    cptAt.current = null;
    lastApplied.current = { sch: 0, drv: 0, pol: 0 };
    pendingOps.current = {};
    pendingCfg.current = null;
    ownerOps.current = {};
    setMeas({ kpi: "", value: "", note: "" });
    setEvNote("");
    setAmend({ title: "", deadline: "", budget: "", reason: "" });
    setGrantF({ kpi: "", count: "", keys: "", value: "", expires: "" });
    setGrSt({ kind: "loading" });
    opSeq.current++;
  }, [biz, id]);

  useEffect(() => {
    /* Silent re-poll: keep the last good snapshot for THIS identity while
       the refetch is in flight. An unconditional "loading" reset on every
       5s poll collapses the page to the skeleton for a frame — document
       height drops below scrollY and the browser clamps the scroll to
       the top. Loading still shows on first fetch and on identity change
       (prev belongs to another route/business). */
    setSt((prev) => {
      const g = pollGate(prev, biz, id);
      return g === "keep" ? prev : g === "no-business" ? { kind: "no-business" } : { kind: "loading" };
    });
    if (!biz || !id) return;
    const ctl = new AbortController();
    api
      .objectiveCockpit(id, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const c = r.cockpit;
        if (String(c.objective.business_id) !== biz) setSt({ kind: "mismatch", objBiz: c.objective.business_id });
        else if (String(c.objective.objective_id) !== id) setSt({ kind: "error", err: new ApiError(0, "IDENTITY_MISMATCH", "Cockpit response identity does not match the requested objective.") });
        else {
          cptAt.current = Date.now();
          setSt({ kind: "ready", data: c, forBiz: biz, forId: id });
        }
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [biz, id, tick, polTick]);

  const refetch = () => setTick((n) => n + 1);

  useEffect(() => {
    if (!biz || !id) return;
    const ctl = new AbortController();
    api
      .autoPolicyStatusApp(id, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        /* Fail-closed identity: a status whose canonical identity is
           not THIS objective/business can never authorize controls —
           render as a typed failure, same contract as the cockpit. */
        const atMs = Date.now();
        const ap = r.auto_policy;
        if (String(ap.objective_id) !== id || String(ap.business_id) !== biz) {
          setPolSt({ kind: "error", err: new ApiError(0, "IDENTITY_MISMATCH", "auto-policy response identity does not match this objective/business — controls stay blocked.") });
        } else {
          /* R1-F7 — record the real observation instant; the render
             clock never refreshes endpoint freshness, and an older or
             aborted- late response can never overwrite a newer one. */
          if (!shouldApplyResponse(lastApplied.current.pol, atMs)) return;
          lastApplied.current.pol = atMs;
          setPolSt({ kind: "ready", data: ap, forId: id, atMs });
        }
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        setPolSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => ctl.abort();
  }, [biz, id, polTick]);

  useEffect(() => {
    if (!biz || !id) return;
    const ctl = new AbortController();
    api
      .autoSchedulerStatusApp(id, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        const d = r.auto_scheduler;
        /* Same fail-closed identity contract as the auto-policy read —
           a scheduler status for another objective is an error, not data. */
        if (String(d.objective_id) !== id) {
          lastApplied.current.sch = atMs;
          setSchSt(epError(null, "IDENTITY_MISMATCH"));
          return;
        }
        if (!shouldApplyResponse(lastApplied.current.sch, atMs)) return;
        lastApplied.current.sch = atMs;
        setSchSt(epReady(d, atMs));
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        lastApplied.current.sch = atMs;
        setSchSt(epError(
          e instanceof ApiError ? e.status : null,
          e instanceof ApiError ? e.code : "ERROR",
        ));
      });
    return () => ctl.abort();
  }, [biz, id, polTick]);

  useEffect(() => {
    if (!biz || !id) return;
    const ctl = new AbortController();
    api
      .autoDriverStatusApp(id, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        const d = r.auto_driver;
        if (String(d.objective_id) !== id) {
          lastApplied.current.drv = atMs;
          setDrvSt(epError(null, "IDENTITY_MISMATCH"));
          return;
        }
        if (!shouldApplyResponse(lastApplied.current.drv, atMs)) return;
        lastApplied.current.drv = atMs;
        setDrvSt(epReady(d, atMs));
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const atMs = Date.now();
        lastApplied.current.drv = atMs;
        setDrvSt(epError(
          e instanceof ApiError ? e.status : null,
          e instanceof ApiError ? e.code : "ERROR",
        ));
      });
    return () => ctl.abort();
  }, [biz, id, polTick]);

  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") {
        setPolTick((n) => n + 1);
        setNowMs(Date.now());
      }
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  /* KPI-verifier grant status — the canonical POST action:"status"
     read. Refetches on identity change, manual refresh and after any
     grant op commit. A POST status read is not abortable through this
     api seam — the dead flag drops late/foreign responses instead. */
  useEffect(() => {
    if (!biz || !id) return;
    let dead = false;
    api
      .objectiveKpiVerificationApp(id, { action: "status" })
      .then((r) => {
        if (dead) return;
        if (String(r.objective_id ?? id) !== id) {
          setGrSt({ kind: "error", err: new ApiError(0, "IDENTITY_MISMATCH", "kpi-verification status does not belong to this objective.") });
          return;
        }
        setGrSt({ kind: "ready", data: r });
      })
      .catch((e: unknown) => {
        if (dead) return;
        setGrSt({ kind: "error", err: e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)) });
      });
    return () => { dead = true; };
  }, [biz, id, grTick, tick]);

  /* Resolve a mutation only while its captured context is still the
     active view. The commit itself is never cancelled — only the
     stale UI attribution is dropped. */
  const settle = (seq: number, ctx: { biz: string; oid: string }, ok: string, failPrefix: string) =>
    (e: unknown, isErr: boolean) => {
      if (seq !== opSeq.current || ctx.biz !== biz || ctx.oid !== id) return;
      setMutBusy(false);
      setMutNote(isErr ? `${failPrefix}: ${e instanceof ApiError ? `${e.code}: ${e.detail}` : String(e)}` : ok);
      if (!isErr) refetch();
    };

  const runCeo = () => {
    if (!dlg || dlg.kind !== "ceo") return;
    const ctx = { biz: dlg.biz, oid: dlg.oid };
    const seq = ++opSeq.current;
    setDlg(null); setMutBusy(true); setMutNote(null);
    api.ceoCycleApp(ctx.oid)
      .then(() => settle(seq, ctx, "CEO pass committed — canonical projection refreshed.", "")(null, false))
      .catch((e: unknown) => settle(seq, ctx, "", "CEO pass failed")(e, true));
  };

  const runPolicy = () => {
    if (!dlg || dlg.kind !== "policy") return;
    const ctx = { biz: dlg.biz, oid: dlg.oid };
    const { action, policyVersion } = dlg;
    /* Fail-closed even with the dialog already open: a mutation is
       only lawful while a canonical status for THIS identity is
       verified and the dialog context still matches the route. An
       unavailable/unverified status locks the operation in place —
       never silently closed, retry resumes when status recovers. */
    const canonNow = polSt.kind === "ready" && polSt.forId === id ? polSt.data : null;
    if (!canonNow || ctx.biz !== biz || ctx.oid !== id) {
      setMutNote(`Policy ${action} blocked — canonical policy status is not verified for this objective/business; the confirmation is locked until status recovers.`);
      return;
    }
    const seq = ++opSeq.current;
    /* Canonicalize limits FIRST: the operation signature derives from
       request semantics (serialized limits), never raw input strings —
       "09" and "9" are the same operation, so an unchanged retry
       always replays the stored body and idempotency key. */
    let canonLimits: { expires_at: string; max_ceo_calls?: number; max_missions?: number; budget_microusd_cap?: number } | undefined;
    if (action === "configure") {
      const limits: { expires_at: string; max_ceo_calls?: number; max_missions?: number; budget_microusd_cap?: number } = {
        expires_at: polLimits.expires ? new Date(polLimits.expires).toISOString() : "",
      };
      if (polLimits.ceo.trim()) limits.max_ceo_calls = Number(polLimits.ceo);
      if (polLimits.missions.trim()) limits.max_missions = Number(polLimits.missions);
      if (polLimits.budget.trim()) limits.budget_microusd_cap = Math.round(Number(polLimits.budget) * 1e6);
      if (!limits.expires_at || (limits.max_ceo_calls === undefined && limits.max_missions === undefined && limits.budget_microusd_cap === undefined)) {
        setMutNote("Configure rejected: limits need expires_at plus at least one cap (max_ceo_calls | max_missions | budget_microusd_cap).");
        return;
      }
      canonLimits = limits;
    }
    /* Operation identity = action + objective + CAS version + canonical
       request semantics. A new operation on a NEWER policy version is a
       different operation (fresh key, current CAS bind); retry of the
       SAME operation identity replays its stored body verbatim.
       Unresolved ops are preserved separately — a pending Configure
       reopened by the owner is an explicit retry of THAT op even when
       canonical version has since drifted. */
    const sig = `${action}:${ctx.oid}:${policyVersion ?? "none"}:${action === "configure" ? JSON.stringify(canonLimits) : ""}`;
    let bodySig = sig;
    let body = pendingOps.current[sig];
    if (!body && action === "configure" && pendingCfg.current && pendingCfg.current.oid === ctx.oid) {
      const ps = pendingCfg.current.sig;
      const pc = pendingOps.current[ps];
      if (pc && JSON.stringify(pc.limits) === JSON.stringify(canonLimits)) {
        body = pc; bodySig = ps;
      }
    }
    if (!body) {
      body = { action, idempotency_key: crypto.randomUUID() };
      /* CAS: the version captured when the dialog opened. First
         configure on an absent policy is the only call allowed to
         omit policy_version. */
      if (policyVersion !== null) body.policy_version = policyVersion;
      if (action === "halt") {
        body.halt_scope = "OBJECTIVE";
        body.halt_reason = "owner halt via company cockpit";
      }
      if (canonLimits) body.limits = canonLimits;
      /* An intentional different configure body supersedes the older
         pending one — an explicit new operation, never an implicit
         reset of the stored retry. */
      if (action === "configure" && pendingCfg.current && pendingCfg.current.oid === ctx.oid && pendingCfg.current.sig !== sig) {
        delete pendingOps.current[pendingCfg.current.sig];
      }
      pendingOps.current[sig] = body;
    }
    if (action === "configure") pendingCfg.current = { oid: ctx.oid, sig: bodySig };
    setDlg(null); setMutBusy(true); setMutNote(null);
    api.autoPolicyControlApp(ctx.oid, body)
      .then((r) => {
        /* A 'committed' report requires the returned canonical state
           to be consistent with this operation's result — otherwise
           discard the op, refetch, and make the owner re-confirm. */
        const EXPECTED: Record<string, string[] | undefined> = {
          configure: ["DISABLED", "EXPIRED"], enable: ["ENABLED"], resume: ["ENABLED"],
          pause: ["PAUSED"], disable: ["DISABLED"], revoke: ["REVOKED"],
          halt: ["HALTED"], reset_halt: ["ENABLED", "PAUSED", "DISABLED"],
        };
        const rp = r?.auto_policy;
        const okStates = EXPECTED[action];
        if (!rp || String(rp.objective_id) !== ctx.oid || (okStates !== undefined && !okStates.includes(String(rp.state)))) {
          delete pendingOps.current[bodySig];
          if (pendingCfg.current?.sig === bodySig) pendingCfg.current = null;
          refetch(); setPolTick((n) => n + 1);
          settle(seq, ctx, "", `Policy ${action} response inconsistent with the requested operation — canonical state refreshed, re-confirm`)(new ApiError(0, "INCONSISTENT_RESPONSE", rp ? `state=${String(rp.state)}` : "no auto_policy in response"), true);
          return;
        }
        delete pendingOps.current[bodySig];
        if (pendingCfg.current?.sig === bodySig) pendingCfg.current = null;
        setPolTick((n) => n + 1);
        settle(seq, ctx, `Policy ${action} committed — projection refreshed.`, "")(null, false);
      })
      .catch((e: unknown) => {
        /* Definitive CAS conflict: discard the stale operation,
           refetch canonical state — the next attempt requires a new
           confirmation (and mints a new operation). */
        if (e instanceof ApiError && e.status === 409) {
          delete pendingOps.current[bodySig];
          if (pendingCfg.current?.sig === bodySig) pendingCfg.current = null;
          refetch();
          setPolTick((n) => n + 1);
          settle(seq, ctx, "", `Policy ${action} conflict — canonical state refreshed, re-confirm as a new operation`)(e, true);
          return;
        }
        settle(seq, ctx, "", `Policy ${action} failed (same operation kept for exact-body retry)`)(e, true);
      });
  };

  /* Shared idempotent owner-op runner (P15.9 Step-0): mint-or-replay
     the stored body for this operation signature — the same inputs
     always replay the same evidence_key / idempotency_key bytes, so
     an ambiguous transport retry can never double-mint. A committed
     result or a definitive 409 conflict discards the stored op. */
  const runOwnerOp = (
    ctx: { biz: string; oid: string },
    sig: string,
    buildBody: () => Record<string, unknown>,
    post: (body: Record<string, unknown>) => Promise<unknown>,
    okMsg: string,
    failMsg: string,
    after?: () => void,
  ) => {
    const seq = ++opSeq.current;
    const body = ownerOps.current[sig] ?? buildBody();
    ownerOps.current[sig] = body;
    setDlg(null); setMutBusy(true); setMutNote(null);
    post(body)
      .then(() => {
        delete ownerOps.current[sig];
        refetch(); setPolTick((n) => n + 1);
        after?.();
        settle(seq, ctx, okMsg, "")(null, false);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 409) {
          delete ownerOps.current[sig];
          refetch(); setPolTick((n) => n + 1);
          settle(seq, ctx, "", `${failMsg} conflict — canonical state refreshed, re-confirm as a new operation`)(e, true);
          return;
        }
        settle(seq, ctx, "", `${failMsg} failed (same operation kept for exact-body retry)`)(e, true);
      });
  };

  const runMeasure = () => {
    if (!dlg || dlg.kind !== "measure") return;
    const ctx = { biz: dlg.biz, oid: dlg.oid };
    /* Strict numeric: Number("")===0 and Number("  ")=0 would mint a
       silent zero measurement — an empty/whitespace field must fail
       here, not coerce. */
    const value = meas.value.trim() === "" ? NaN : Number(meas.value);
    if (!meas.kpi || !Number.isFinite(value)) {
      setMutNote("Measurement rejected: a KPI and a numeric value are required.");
      return;
    }
    runOwnerOp(
      ctx,
      `measure:${ctx.oid}:${meas.kpi}:${value}:${meas.note}`,
      () => ({
        business_id: ctx.biz, kpi_id: meas.kpi, value,
        evidence_key: crypto.randomUUID(), source: "owner-console",
        note: meas.note || undefined,
      }),
      (b) => api.objectiveRecordProgressApp(ctx.oid, b as never),
      `Measurement committed — owner-attested progress written to ${meas.kpi}.`,
      "Measurement",
    );
  };

  const runEvidence = () => {
    if (!dlg || dlg.kind !== "evidence") return;
    const ctx = { biz: dlg.biz, oid: dlg.oid };
    runOwnerOp(
      ctx,
      `evidence:${ctx.oid}:${evNote}`,
      () => ({
        business_id: ctx.biz,
        evidence_key: crypto.randomUUID(), source: "owner-console",
        note: evNote || undefined,
      }),
      (b) => api.objectiveAttachEvidenceApp(ctx.oid, b as never),
      "Evidence attached — canonical EVIDENCE ref appended.",
      "Attach evidence",
    );
  };

  const runAmend = () => {
    if (!dlg || dlg.kind !== "amend") return;
    const ctx = { biz: dlg.biz, oid: dlg.oid };
    const patch: Record<string, unknown> = {};
    /* Diff-only: the canonical amend bumps terms_version and rebinds
       objective_digest for EVERY supplied key — sending unchanged
       values would invalidate pinned reviews/policy grants for no
       reason. Only fields that genuinely differ are patched. */
    if (amend.title.trim() && amend.title.trim() !== String(o.title ?? "")) {
      patch.title = amend.title.trim();
    }
    if (amend.deadline) {
      const dl = new Date(amend.deadline);
      if (Number.isNaN(dl.getTime())) {
        setMutNote("Amendment rejected: deadline is not a valid date.");
        return;
      }
      patch.deadline = dl.toISOString();
    }
    if (amend.budget.trim()) {
      const usd = Number(amend.budget);
      if (!Number.isFinite(usd) || usd < 0) {
        setMutNote("Amendment rejected: budget ceiling must be a non-negative USD amount.");
        return;
      }
      const micro = Math.round(usd * 1e6);
      if (micro !== Number(o.budget.ceiling_microusd)) {
        patch.budget_ceiling_microusd = micro;
      }
    }
    if (!Object.keys(patch).length) {
      setMutNote("Amendment rejected: no field differs from the current terms — nothing to commit.");
      return;
    }
    runOwnerOp(
      ctx,
      `amend:${ctx.oid}:${JSON.stringify(patch)}:${amend.reason}`,
      /* The key mints ONCE per stored op body — an ambiguous retry
         replays the same bytes, and the service dedups on the key so
         a committed-but-lost response can never double-commit. */
      () => ({ business_id: ctx.biz, patch, reason: amend.reason || undefined,
        idempotency_key: crypto.randomUUID() }),
      (b) => api.objectiveAmendApp(ctx.oid, b as never),
      "Amendment committed — terms re-bound (terms_version bumped).",
      "Amendment",
    );
  };

  const runGrant = () => {
    if (!dlg || dlg.kind !== "kpi-grant") return;
    const ctx = { biz: dlg.biz, oid: dlg.oid };
    const rule: Record<string, unknown> = { rule_type: "DELIVERABLE_BUNDLE" };
    if (grantF.count.trim()) {
      const n = Number(grantF.count);
      if (!Number.isSafeInteger(n) || n < 1 || n > 256) {
        setMutNote("Grant rejected: required_count must be an integer 1–256.");
        return;
      }
      rule.required_count = n;
    }
    const keys = grantF.keys.split(",").map((x) => x.trim()).filter(Boolean);
    if (keys.length) rule.required_keys = keys;
    if (rule.required_count === undefined && rule.required_keys === undefined) {
      setMutNote("Grant rejected: the rule needs required_count and/or required_keys.");
      return;
    }
    const pv = grantF.value.trim() === "" ? NaN : Number(grantF.value);
    if (!Number.isFinite(pv)) {
      setMutNote("Grant rejected: progress_value must be a finite number.");
      return;
    }
    rule.progress_value = pv;
    if (!grantF.kpi || !grantF.expires) {
      setMutNote("Grant rejected: a KPI and a future expires_at are required.");
      return;
    }
    const exp = new Date(grantF.expires);
    if (Number.isNaN(exp.getTime())) {
      setMutNote("Grant rejected: expires_at is not a valid date.");
      return;
    }
    const expiresAt = exp.toISOString();
    runOwnerOp(
      ctx,
      `kpi-grant:${ctx.oid}:${grantF.kpi}:${JSON.stringify(rule)}:${expiresAt}`,
      () => ({
        action: "grant", kpi_id: grantF.kpi, rule, expires_at: expiresAt,
        idempotency_key: crypto.randomUUID(),
      }),
      (b) => api.objectiveKpiVerificationApp(ctx.oid, b as never),
      "KPI-verifier grant committed — scheduler woken inside the same commit.",
      "Grant",
      () => setGrTick((n) => n + 1),
    );
  };

  const runKpiControl = () => {
    if (!dlg || dlg.kind !== "kpi-control") return;
    const ctx = { biz: dlg.biz, oid: dlg.oid };
    const action = dlg.action;
    runOwnerOp(
      ctx,
      `kpi-${action}:${ctx.oid}:${dlg.authorization_id}`,
      () => ({
        action, authorization_id: dlg.authorization_id,
        idempotency_key: crypto.randomUUID(),
      }),
      (b) => api.objectiveKpiVerificationApp(ctx.oid, b as never),
      `Grant ${action} committed.`,
      `Grant ${action}`,
      () => setGrTick((n) => n + 1),
    );
  };

  /* Autonomous-loop input bundle — identity-guarded reads only. The
     cockpit read is ready here only when st already carries data for
     THIS route; the loop never sees a foreign objective. */
  const loopInputs: LoopInputs | null = useMemo(() => {
    if (!id || !biz || st.kind !== "ready" || st.forId !== id || st.forBiz !== biz)
      return null;
    return {
      objectiveId: id,
      nowMs,
      cockpit: epReady(st.data, cptAt.current ?? nowMs),
      policy:
        polSt.kind === "ready" && polSt.forId === id
          ? epReady(polSt.data, polSt.atMs)
          : polSt.kind === "error"
            ? epError(polSt.err.status, polSt.err.code)
            : epMissing(),
      scheduler: schSt,
      driver: drvSt,
    };
  }, [id, biz, st, polSt, schSt, drvSt, nowMs]);

  if (st.kind === "no-business") {
    return (<><h1>Objective</h1><EmptyState title="No business selected" detail="Select a business first — objective detail is rendered inside the selected-business context." /></>);
  }
  if (st.kind === "loading") {
    return (<><h1>Objective</h1><div className="sub">Loading {id}…</div><div className="stats">{[0,1,2].map(i=><div className="stat" key={i}><Skeleton height={11} width="70%"/><Skeleton height={22} width="40%"/></div>)}</div><Skeleton height={120} /></>);
  }
  if (st.kind === "mismatch") {
    return (<><h1>Objective</h1><DeniedState detail={`Objective ${id} belongs to business ${st.objBiz}, not the selected ${biz}. Switch business to view it — nothing from another business is shown.`} /></>);
  }
  if (st.kind === "error") {
    const { err } = st;
    return (
      <><h1>Objective</h1><div className="sub">{biz}</div>
        {err.status === 401 ? (
          <ErrorState code={err.code || "UNAUTHORIZED"} detail="Your credentials were rejected — update the session token and retry." onRetry={refetch} />
        ) : err.status === 403 ? (
          <DeniedState detail={`${err.detail || "You don't own this objective."} (${err.code})`} />
        ) : (
          <ErrorState code={err.code} detail={err.code.startsWith("FAIL_CLOSED") ? `Integrity check failed — possibly-corrupt data was not rendered. ${err.detail}` : err.detail} onRetry={refetch} />
        )}
      </>
    );
  }

  /* R2-F1 — synchronous identity guard at the render boundary:
     never paint ready data belonging to another route or business.
     Stale-for-this-route data renders the loading state while the
     effect fetch for the current params completes. */
  if (st.forBiz !== biz || st.forId !== id ||
      String(st.data.objective.objective_id) !== id ||
      String(st.data.objective.business_id) !== biz) {
    return (<><h1>Objective</h1><div className="sub">Loading {id}…</div><div className="stats">{[0,1,2].map(i=><div className="stat" key={i}><Skeleton height={11} width="70%"/><Skeleton height={22} width="40%"/></div>)}</div><Skeleton height={120} /></>);
  }

  const c = st.data;
  const o = c.objective;
  const obsErr = c.observation_error !== null;
  const kpisMet = c.kpi_summary.all_targets_met;
  const converging = kpisMet && c.workstreams.some((w) => w.workstream_status === "BACKLOG" || w.workstream_status === "IN_PROGRESS");
  /* Control state = canonical polled GET when loaded; the cockpit
     snapshot is only the loading fallback. Button legality and CAS
     version always derive from this merged view. */
  const polCanon = polSt.kind === "ready" && polSt.forId === id ? polSt.data : null;
  /* `pol` = observation only (canonical when loaded, else cockpit
     snapshot — labeled non-authoritative). `polCtl` = the only thing
     allowed to authorize a mutation button: a verified canonical
     status for THIS identity. Until it exists, controls stay closed. */
  const pol = polCanon ?? c.auto_policy;
  const polCtl = polCanon;

  /* datetime-local needs "YYYY-MM-DDTHH:mm" — prefill the configure
     window from the objective deadline only when it is a real future
     instant; an absent/past deadline never fabricates a window. */
  const toLocalInput = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const openPolicyDlg = (a: string) => {
    /* A pending Configure operation restores its ORIGINAL submitted
       values on reopen — defaults never overwrite an unresolved
       operation. Only a first-time configure falls back to
       terms-derived proposals. */
    const pc = a === "configure" && pendingCfg.current && pendingCfg.current.oid === id
      ? pendingOps.current[pendingCfg.current.sig] : undefined;
    if (a === "configure") {
      if (pc?.limits) {
        const l = pc.limits;
        setPolLimits({
          expires: l.expires_at ? toLocalInput(new Date(l.expires_at)) : "",
          ceo: l.max_ceo_calls !== undefined ? String(l.max_ceo_calls) : "",
          missions: l.max_missions !== undefined ? String(l.max_missions) : "",
          budget: l.budget_microusd_cap !== undefined ? String(l.budget_microusd_cap / 1e6) : "",
        });
        const canonV = polCtl?.configured ? polCtl.policy_version ?? null : null;
        setPolPending(
          "Pending configure restored — retry submits the identical limits, version and idempotency key." +
          (canonV !== null && pc.policy_version !== undefined && pc.policy_version !== canonV
            ? ` Canonical policy_version is now v${canonV} while this operation was bound to v${String(pc.policy_version)} — a conflict refreshes canonical state and requires a fresh confirmation.`
            : "")
        );
      } else {
        const dl = o.deadline ? new Date(o.deadline) : null;
        const okDl = dl !== null && !Number.isNaN(dl.getTime()) && dl.getTime() > Date.now();
        setPolLimits({
          expires: okDl ? toLocalInput(dl as Date) : "",
          ceo: "20",
          missions: "5",
          budget: o.budget.ceiling_microusd > 0 ? String(o.budget.ceiling_microusd / 1e6) : "",
        });
        setPolPending(null);
      }
    } else {
      setPolPending(null);
    }
    setDlg({
      kind: "policy",
      action: a,
      biz: biz!,
      oid: id,
      /* CAS binding for a NEW operation always comes from current
         canonical state; a pending op's own version stays sealed
         inside its stored body and is replayed verbatim on retry. */
      policyVersion: polCtl?.configured ? (polCtl.policy_version ?? null) : null,
    });
  };

  return (
    <>
      <div className="chead">
        <div>
          <div className="sub"><Link to="/app/objectives">‹ Objectives</Link> / {o.objective_id}</div>
          <h1>{o.title || o.objective_id}</h1>
          <div className="sub">
            {o.statement || "—"} · deadline {o.deadline ? String(o.deadline).slice(0, 10) : "none"} · owner {o.owner_authority_id} · terms v{o.terms_version} · obj v{o.version} · biz {biz}
          </div>
        </div>
        <StatusBadge tone={S_TONE[o.status] ?? "unknown"} label={o.status} />
      </div>

      {mutNote ? <div className="trunc" role="status">{mutNote}</div> : null}

      <div className="stats">
        <div className="stat">
          <div className="k">KPI</div>
          <div className="v" style={{ fontSize: 14, lineHeight: 1.6 }}>
            {c.kpi_summary.verified_kpi_count} verified · {c.kpi_summary.gap_kpi_count} gap · {c.kpi_summary.unverified_kpi_count} unverified
          </div>
          <div className="n">{kpisMet ? "all targets met" : "targets open"}</div>
        </div>
        <div className="stat">
          <div className="k">Budget</div>
          <div className="v" style={{ fontSize: 18, lineHeight: 1.6 }}>{money(o.budget.consumed_microusd)} / {money(o.budget.ceiling_microusd)}</div>
          <div className="n">{o.budget.canonically_proven ? "proven" : "claimed — not proven"} · aggregate display only</div>
        </div>
        <div className="stat">
          <div className="k">Lifecycle</div>
          <div className="v" style={{ fontSize: 14, lineHeight: 1.6 }}>
            {o.status}{converging ? " — workstreams still converging" : ""}
            {c.lifecycle.latest_review_outcome ? ` · last review ${c.lifecycle.latest_review_outcome}` : ""}
          </div>
          <div className="n">
            {c.lifecycle.owner_action_required ? "owner action REQUIRED (fresh)" : "no pending owner action"}
            {c.lifecycle.recommended_status ? ` · recommended ${c.lifecycle.recommended_status}` : ""}
          </div>
        </div>
      </div>

      {obsErr ? (
        <UnverifiedPanel title="Observation failed integrity check" detail={`${c.observation_error} — KPI/workstream/budget claims below are shown as unverified claims, never verified evidence.`} />
      ) : null}

      {loopInputs ? <ObjectiveAutonomousLoop inputs={loopInputs} nowMs={nowMs} /> : null}

      <h2 className="sech">Owner actions</h2>
      <div className="actions">
        <button className="primary" disabled={mutBusy} onClick={() => setDlg({ kind: "ceo", biz: biz!, oid: id })}>Run CEO pass</button>
        <button
          className="ghost" disabled={mutBusy || o.kpis.length === 0}
          title={o.kpis.length === 0 ? "No KPIs declared — nothing to measure" : "Record an owner-attested KPI measurement (canonical owner-verifier seam)"}
          onClick={() => { setMeas({ kpi: o.kpis[0]?.kpi_id ?? "", value: "", note: "" }); setDlg({ kind: "measure", biz: biz!, oid: id }); }}
        >Record KPI measurement</button>
        <button
          className="ghost" disabled={mutBusy}
          title="Attach an owner-verified evidence ref (no KPI write)"
          onClick={() => { setEvNote(""); setDlg({ kind: "evidence", biz: biz!, oid: id }); }}
        >Attach evidence</button>
        <button
          className="ghost" disabled={mutBusy}
          title="Amend objective terms — canonical re-bind bumps terms_version"
          onClick={() => { setAmend({ title: String(o.title ?? ""), deadline: "", budget: o.budget.ceiling_microusd > 0 ? String(o.budget.ceiling_microusd / 1e6) : "", reason: "" }); setDlg({ kind: "amend", biz: biz!, oid: id }); }}
        >Amend objective</button>
        {c.lifecycle.owner_action_required ? (
          <Link className="go" to="/app/inbox" title="A TARGET_MET_CANDIDATE review is pending — accept it in the Inbox">review pending sign-off → Inbox</Link>
        ) : null}
      </div>
      <div className="sub">
        Measurement is <strong>owner-attested</strong>: the verifier is your operator identity, written
        through the canonical owner-verifier seam — never model output. Grants below delegate that same
        write to the KPI verifier under a bounded rule.
      </div>

      <h2 className="sech">KPIs</h2>
      <div className="need">
        {o.kpis.length === 0 ? <div className="nrow"><span className="note">No KPIs declared.</span></div> : null}
        {o.kpis.map((k) => (
          <div className="nrow" key={k.kpi_id}>
            <span className="tt">{k.name}</span>
            <span className="note">
              {k.current ?? "—"}/{k.target} {k.unit} · {k.direction} · baseline {k.baseline}
            </span>
            <StatusBadge tone={k.canonically_proven ? (S_TONE[k.assessment] ?? "unknown") : "unknown"} label={k.canonically_proven ? k.assessment : "UNVERIFIED"} />
            <ProofChip state={k.canonically_proven ? "proven" : "unverifiable"} />
          </div>
        ))}
      </div>

      <h2 className="sech">Plan & workstreams</h2>
      {obsErr ? (
        <EmptyState title="Workstream state unverified" detail="Observation integrity failed — claims are not rendered as verified." />
      ) : c.binding === null ? (
        <EmptyState title="no canonical plan yet" detail="Pre-binding objective — no CEO plan has bound workstreams." />
      ) : (
        <>
          <div className="sub">binding {c.binding.binding_id} · digest {c.binding.binding_digest.slice(0, 12)}…</div>
          <div className="need">
            {c.workstreams.length === 0 ? <div className="nrow"><span className="note">Binding exists but no workstreams returned.</span></div> : null}
            {c.workstreams.map((w) => (
              <div className="nrow" key={w.workstream_key}>
                <span className="tt">{w.workstream_key}</span>
                <StatusBadge tone={S_TONE[w.workstream_status] ?? "unknown"} label={w.workstream_status} />
                <ProofChip state={w.completion_proven ? "proven" : "claimed"} />
                <span className="note">
                  {w.allocation_state}{w.selected_agent_id ? ` · ${w.selected_agent_id}` : ""}
                  {w.delegated_child ? ` → ${w.delegated_child.work_item_id} ${w.delegated_child.status}` : " (no delegated child)"}
                </span>
                {w.delegated_child?.mission ? (
                  <Link className="go" to={`/app/missions/${encodeURIComponent(w.delegated_child.mission.mission_id)}`}>
                    {w.delegated_child.mission.mission_id.slice(0, 12)}… {w.delegated_child.mission.status}
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="sech">Missions</h2>
      <div className="need">
        {c.missions.length === 0 ? <div className="nrow"><span className="note">No missions bound yet — they appear when the CEO plan delegates work.</span></div> : null}
        {c.missions.map((m) => (
          <div className="nrow" key={m.mission_id}>
            <span className="tt">{m.mission_id}</span>
            <StatusBadge tone={S_TONE[m.status] ?? "unknown"} label={m.status} />
            <span className="note">runtime {m.runtime_state ?? "—"}</span>
            <Link className="go" to={`/app/missions/${encodeURIComponent(m.mission_id)}`}>open mission →</Link>
          </div>
        ))}
      </div>

      <div className="grid2">
        <section>
          <h2 className="sech">Artifacts{c.artifacts_dropped_unverified > 0 ? ` (+${c.artifacts_dropped_unverified} dropped unverifiable)` : ""}</h2>
          {c.artifacts_truncated ? <div className="sub">Partial list — verified artifacts bounded.</div> : null}
          <div className="need">
            {c.artifacts.length === 0 ? <div className="nrow"><span className="note">No verified artifacts.</span></div> : null}
            {c.artifacts.map((a) => (
              <div className="nrow" key={a.artifact_id}>
                <span className="tt">{a.logical_name}</span>
                <span className="note">{a.artifact_class} · {a.byte_size}B · {a.mission_id.slice(0, 12)}…</span>
                <ProofChip state="proven" />
              </div>
            ))}
          </div>
        </section>
        <section>
          <h2 className="sech">Reviews ({c.review_count})</h2>
          <div className="need">
            {c.latest_review === null ? <div className="nrow"><span className="note">No reviews yet.</span></div> : (
              <div className="nrow">
                <StatusBadge tone={S_TONE[c.latest_review.outcome] ?? "unknown"} label={c.latest_review.outcome} />
                <span className="note">{String(c.latest_review.created_at).slice(0, 19).replace("T", " ")} · historical flag {String(c.latest_review.owner_action_required)}</span>
              </div>
            )}
            <div className="nrow"><Link className="go" to={`/app/objectives/${encodeURIComponent(o.objective_id)}/reviews`}>view all reviews →</Link></div>
          </div>
        </section>
      </div>

      <h2 className="sech">Auto-run controls</h2>
      <div className="need">
        <div className="nrow">
          <span className="tt">policy</span>
          {!pol?.configured ? (
            <span className="note">not configured — owner must enable before the driver may act</span>
          ) : (
            <>
              <StatusBadge tone={S_TONE[String(pol.state)] ?? "unknown"} label={String(pol.state)} />
              <span className="note">
                v{pol.policy_version ?? "—"} · effective {String(pol.effective)}
                {pol.expires_at ? ` · expires ${String(pol.expires_at).slice(0, 16).replace("T", " ")}` : ""}
                {!polCanon ? " · snapshot — canonical status still loading" : ""}
              </span>
            </>
          )}
          {pol && "expiry_pending" in pol && pol.expiry_pending ? <StatusBadge tone="warn" label="policy expired — awaiting canonical commit" /> : null}
        </div>
        {pol?.configured ? (
          <div className="nrow">
            <span className="tt">limits</span>
            <span className="note">
              {pol.limits
                ? `${pol.limits.max_ceo_calls ?? "—"} ceo calls · ${pol.limits.max_missions ?? "—"} missions · ${pol.limits.max_retries ?? "—"} retries · ${pol.limits.budget_microusd_cap != null ? money(Number(pol.limits.budget_microusd_cap)) : "—"} cap` + (pol.limits.expires_at ? ` · until ${String(pol.limits.expires_at).slice(0, 16).replace("T", " ")}` : "")
                : "no limits recorded"}
            </span>
          </div>
        ) : null}
        <div className="nrow">
          <span className="tt">driver</span>
          {polCanon ? (
            polCanon.driver_ready ? (
              <><StatusBadge tone="ok" label="READY" /><span className="note">eligible — the driver may act on this objective</span></>
            ) : (
              <><StatusBadge tone="warn" label="NOT READY" /><span className="note">{(polCanon.driver_missing ?? []).join(", ") || "driver reports no missing reasons"}</span></>
            )
          ) : (
            <span className="note">{c.auto_driver ? `status: ${JSON.stringify(c.auto_driver.status)}` : "not configured"}</span>
          )}
        </div>
        {pol?.configured && "halt" in pol && pol.halt ? (
          <div className="nrow">
            <span className="tt">halt</span>
            <StatusBadge tone="danger" label={pol.halt.scope} />
            <span className="note">{pol.halt.reason} · {pol.halt.actor} · {String(pol.halt.at).slice(0, 16).replace("T", " ")}</span>
          </div>
        ) : null}
        {pol?.configured && Array.isArray(pol.reasons) && pol.reasons.length ? (
          <div className="nrow"><span className="tt">reasons</span><span className="note">{pol.reasons.join(", ")}</span></div>
        ) : null}
        {polSt.kind === "error" ? (
          <div className="nrow">
            <span className="tt">status fetch</span>
            <span className="note">{polSt.err.code}: {polSt.err.detail} — policy mutations blocked until a canonical status loads.</span>
            <button className="ghost" onClick={() => setPolTick((n) => n + 1)}>Retry status</button>
          </div>
        ) : null}
        {polSt.kind === "loading" ? (
          <div className="nrow"><span className="tt">status fetch</span><span className="note">loading canonical status — controls stay closed until verified.</span></div>
        ) : null}
      </div>
      <div className="actions">
        {polCtl === null ? null : (
          !polCtl.configured ? ["configure"] : Object.keys(POLICY_TRANSITIONS).filter((a) => POLICY_TRANSITIONS[a].includes(String(polCtl.state)))
        ).map((a) => (
          <button key={a} className="ghost" disabled={mutBusy} onClick={() => openPolicyDlg(a)}>
            {a === "configure" && polCtl.state === "EXPIRED" ? "Re-arm policy (new limits)" : (POLICY_LABELS[a] ?? a)}
          </button>
        ))}
      </div>

      <h2 className="sech">KPI verifier grants</h2>
      <div className="sub">
        Delegated write authority: a grant lets the canonical KPI verifier write progress to one KPI
        when its DELIVERABLE_BUNDLE rule is satisfied — expiry-bounded and revocable. Grant +
        scheduler wake commit atomically; the verifier writer is never your identity.
      </div>
      <div className="need">
        {grSt.kind === "loading" ? (
          <div className="nrow"><span className="note">loading grant status…</span></div>
        ) : null}
        {grSt.kind === "error" ? (
          <div className="nrow">
            <span className="tt">status</span>
            <span className="note">{grSt.err.code}: {grSt.err.detail}</span>
            <button className="ghost" onClick={() => setGrTick((n) => n + 1)}>Retry</button>
          </div>
        ) : null}
        {grSt.kind === "ready" ? (
          <>
            {(Array.isArray(grSt.data.grants) ? (grSt.data.grants as Array<Record<string, unknown>>) : []).length === 0 ? (
              <div className="nrow"><span className="note">No KPI-verifier grants — KPI progress can only come from owner measurement.</span></div>
            ) : null}
            {(Array.isArray(grSt.data.grants) ? (grSt.data.grants as Array<Record<string, unknown>>) : []).map((g) => (
              <div className="nrow" key={String(g.authorization_id)}>
                <span className="tt">{String(g.authorization_id)}</span>
                <StatusBadge tone={S_TONE[String(g.state)] ?? "unknown"} label={String(g.state)} />
                {g.effective === true ? <ProofChip state="proven" /> : <StatusBadge tone="warn" label="INEFFECTIVE" />}
                <span className="note">
                  kpi {String(g.kpi_id)} · expires {String(g.expires_at).slice(0, 16).replace("T", " ")}
                  {g.ineffective_reason ? ` · ${String(g.ineffective_reason)}` : ""}
                </span>
                {String(g.state) === "ENABLED" ? (
                  <>
                    <button className="ghost" disabled={mutBusy}
                      onClick={() => setDlg({ kind: "kpi-control", action: "disable", biz: biz!, oid: id, authorization_id: String(g.authorization_id) })}
                    >disable</button>
                    <button className="ghost" disabled={mutBusy}
                      onClick={() => setDlg({ kind: "kpi-control", action: "revoke", biz: biz!, oid: id, authorization_id: String(g.authorization_id) })}
                    >revoke</button>
                  </>
                ) : null}
              </div>
            ))}
            {(Array.isArray(grSt.data.receipts) ? (grSt.data.receipts as Array<Record<string, unknown>>) : []).length > 0 ? (
              <div className="nrow">
                <span className="tt">receipts</span>
                <span className="note">
                  {(grSt.data.receipts as Array<Record<string, unknown>>).length} committed —{" "}
                  {(grSt.data.receipts as Array<Record<string, unknown>>)
                    .map((r) => `${String(r.kpi_id)}→${String(r.progress_value)}`)
                    .join(", ")}
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="actions">
        <button
          className="ghost" disabled={mutBusy || o.kpis.length === 0}
          title={o.kpis.length === 0 ? "No KPIs declared — nothing to delegate" : "Grant bounded delegated write authority for one KPI"}
          onClick={() => { setGrantF({ kpi: o.kpis[0]?.kpi_id ?? "", count: "", keys: "", value: "", expires: "" }); setDlg({ kind: "kpi-grant", biz: biz!, oid: id }); }}
        >Grant KPI verification</button>
      </div>

      <ConfirmDialog
        open={dlg?.kind === "ceo"}
        title="Run CEO pass"
        body={`Run a real CEO pass on ${dlg?.kind === "ceo" ? dlg.oid : o.objective_id} in ${dlg?.kind === "ceo" ? dlg.biz : biz}? This commits a canonical ceo-cycle — not a simulation. The projection refetches after it lands.`}
        confirmLabel="Run CEO pass"
        busy={mutBusy}
        onConfirm={runCeo}
        onCancel={() => setDlg(null)}
      />
      <ConfirmDialog
        open={dlg?.kind === "policy"}
        title={dlg?.kind === "policy" ? (POLICY_LABELS[dlg.action] ?? dlg.action) : "Auto policy"}
        body={dlg?.kind === "policy"
          ? `Commit "${dlg.action}" on ${dlg.oid} in ${dlg.biz}?${dlg.policyVersion !== null ? ` CAS on policy_version ${dlg.policyVersion}.` : " First configure on an absent policy — no version required."} Posts the real control contract with a generated idempotency key; projection refetches after commit.`
          : ""}
        confirmLabel={dlg?.kind === "policy" ? `Commit ${dlg.action}` : "Commit"}
        busy={mutBusy}
        confirmDisabled={polSt.kind !== "ready" || polSt.forId !== id}
        onConfirm={runPolicy}
        onCancel={() => setDlg(null)}
      >
        {dlg?.kind === "policy" && (polSt.kind !== "ready" || polSt.forId !== id) ? (
          <div className="note">Canonical policy status unavailable — this confirmation is locked until the status GET recovers; no request is sent.</div>
        ) : null}
        {dlg?.kind === "policy" && polPending ? (
          <div className="note">{polPending}</div>
        ) : null}
        {dlg?.kind === "policy" && dlg.action === "configure" ? (
          <div className="ofrow" aria-label="policy limits">
            <label htmlFor="pex">expires_at (required)</label>
            <input id="pex" type="datetime-local" value={polLimits.expires} onChange={(e) => setPolLimits({ ...polLimits, expires: e.target.value })} />
            <div className="ofrow2">
              <input placeholder="max_ceo_calls" aria-label="max ceo calls" value={polLimits.ceo} onChange={(e) => setPolLimits({ ...polLimits, ceo: e.target.value })} />
              <input placeholder="max_missions" aria-label="max missions" value={polLimits.missions} onChange={(e) => setPolLimits({ ...polLimits, missions: e.target.value })} />
            </div>
            <input placeholder="budget cap (USD)" aria-label="budget cap usd" value={polLimits.budget} onChange={(e) => setPolLimits({ ...polLimits, budget: e.target.value })} />
          </div>
        ) : null}
      </ConfirmDialog>

      {/* ---- P15.9 Step-0 owner-action dialogs ---- */}
      <ConfirmDialog
        open={dlg?.kind === "measure"}
        title="Record KPI measurement"
        body="Commit an owner-attested KPI measurement? The evidence verifier is your operator identity — this is the canonical owner-verifier write, never model output. Idempotent by evidence_key."
        confirmLabel="Commit measurement"
        busy={mutBusy}
        onConfirm={runMeasure}
        onCancel={() => setDlg(null)}
      >
        {dlg?.kind === "measure" ? (
          <div className="ofrow" aria-label="kpi measurement">
            <label htmlFor="mkpi">KPI</label>
            <select id="mkpi" value={meas.kpi} onChange={(e) => setMeas({ ...meas, kpi: e.target.value })}>
              {o.kpis.map((k) => (
                <option key={k.kpi_id} value={k.kpi_id}>
                  {k.name} ({k.current ?? "—"}/{k.target} {k.unit})
                </option>
              ))}
            </select>
            <div className="ofrow2">
              <input placeholder="value" aria-label="measured value" inputMode="decimal"
                value={meas.value} onChange={(e) => setMeas({ ...meas, value: e.target.value })} />
              <input placeholder="note (optional)" aria-label="measurement note"
                value={meas.note} onChange={(e) => setMeas({ ...meas, note: e.target.value })} />
            </div>
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={dlg?.kind === "evidence"}
        title="Attach evidence"
        body="Attach an owner-verified evidence ref? It appends a canonical EVIDENCE entry (no KPI write) bound to your operator identity."
        confirmLabel="Attach evidence"
        busy={mutBusy}
        onConfirm={runEvidence}
        onCancel={() => setDlg(null)}
      >
        {dlg?.kind === "evidence" ? (
          <div className="ofrow" aria-label="attach evidence">
            <input placeholder="note describing the evidence (optional)" aria-label="evidence note"
              value={evNote} onChange={(e) => setEvNote(e.target.value)} />
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={dlg?.kind === "amend"}
        title="Amend objective"
        body="Commit an owner amendment? Canonical terms re-bind: terms_version bumps and pinned reviews/policy grants re-prove against the new terms. Only filled fields change."
        confirmLabel="Commit amendment"
        busy={mutBusy}
        onConfirm={runAmend}
        onCancel={() => setDlg(null)}
      >
        {dlg?.kind === "amend" ? (
          <div className="ofrow" aria-label="amend objective">
            <label htmlFor="atitle">title</label>
            <input id="atitle" value={amend.title} onChange={(e) => setAmend({ ...amend, title: e.target.value })} />
            <div className="ofrow2">
              <input type="datetime-local" aria-label="new deadline" value={amend.deadline}
                onChange={(e) => setAmend({ ...amend, deadline: e.target.value })} />
              <input placeholder="budget ceiling (USD)" aria-label="new budget ceiling usd" inputMode="decimal"
                value={amend.budget} onChange={(e) => setAmend({ ...amend, budget: e.target.value })} />
            </div>
            <input placeholder="reason (optional)" aria-label="amendment reason"
              value={amend.reason} onChange={(e) => setAmend({ ...amend, reason: e.target.value })} />
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={dlg?.kind === "kpi-grant"}
        title="Grant KPI verification"
        body="Grant the canonical KPI verifier bounded write authority for one KPI? It may write progress only while the grant is ENABLED, unexpired, and its DELIVERABLE_BUNDLE rule is provably satisfied by verified deliverables — then the scheduler wakes inside the same commit."
        confirmLabel="Commit grant"
        busy={mutBusy}
        onConfirm={runGrant}
        onCancel={() => setDlg(null)}
      >
        {dlg?.kind === "kpi-grant" ? (
          <div className="ofrow" aria-label="kpi verifier grant">
            <label htmlFor="gkpi">KPI</label>
            <select id="gkpi" value={grantF.kpi} onChange={(e) => setGrantF({ ...grantF, kpi: e.target.value })}>
              {o.kpis.map((k) => (
                <option key={k.kpi_id} value={k.kpi_id}>{k.name} ({k.kpi_id})</option>
              ))}
            </select>
            <div className="ofrow2">
              <input placeholder="required_count" aria-label="required verified units" inputMode="numeric"
                value={grantF.count} onChange={(e) => setGrantF({ ...grantF, count: e.target.value })} />
              <input placeholder="required_keys (comma-sep)" aria-label="required workstream keys"
                value={grantF.keys} onChange={(e) => setGrantF({ ...grantF, keys: e.target.value })} />
            </div>
            <div className="ofrow2">
              <input placeholder="progress_value" aria-label="value written on satisfaction" inputMode="decimal"
                value={grantF.value} onChange={(e) => setGrantF({ ...grantF, value: e.target.value })} />
              <input type="datetime-local" aria-label="grant expiry" value={grantF.expires}
                onChange={(e) => setGrantF({ ...grantF, expires: e.target.value })} />
            </div>
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={dlg?.kind === "kpi-control"}
        title={dlg?.kind === "kpi-control" ? `${dlg.action === "revoke" ? "Revoke" : "Disable"} grant` : "Grant"}
        body={dlg?.kind === "kpi-control"
          ? `${dlg.action === "revoke" ? "Revoke" : "Disable"} grant ${dlg.authorization_id} on ${dlg.oid}? The KPI verifier loses write authority immediately (revoke is terminal; disable is reversible).`
          : ""}
        confirmLabel={dlg?.kind === "kpi-control" ? `Commit ${dlg.action}` : "Commit"}
        busy={mutBusy}
        onConfirm={runKpiControl}
        onCancel={() => setDlg(null)}
      />
    </>
  );
}
