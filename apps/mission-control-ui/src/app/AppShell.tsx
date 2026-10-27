import { NavLink, Outlet, useLocation } from "react-router-dom";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getOperatorId } from "../api";
import { useTheme } from "../lib/useTheme";
import { api } from "../api";
import { Toasts } from "../components/Toast";
import { onInboxInvalidate } from "./lib/inboxCounts";

/* P15.9-B1 — AppShell: sidebar + topbar + mobile tab bar (B.3, D.1).
   Business switcher uses the manual/last-used `business_id` contract (B.5.3):
   NO /api/businesses enumeration — that route is unfiltered. */

const BIZ_KEY = "pair.business_id";

export function getBusinessId(): string {
  return localStorage.getItem(BIZ_KEY) ?? "";
}
export function setBusinessId(id: string) {
  const v = id.trim();
  if (v) localStorage.setItem(BIZ_KEY, v);
  else localStorage.removeItem(BIZ_KEY);
}

/* Single source of truth for the selected business (B1 audit R1-F1):
   AppShell owns the state; every mounted switcher (sidebar, tablet
   topbar, mobile drawer) and later B2 pages read/write through it. */
const BizContext = createContext<{ biz: string; select: (id: string) => void }>({
  biz: "",
  select: () => {},
});
export function useSelectedBusiness() {
  return useContext(BizContext);
}

/* UI-V2 — owner-first nav (mission fixed decision):
   Tổng quan / Mục tiêu / Công việc / Phê duyệt / Nhân sự AI +
   "Nâng cao" collapsed group. Owner vs Advanced is a PRESENTATION
   toggle only — same routes, same authority, same data. */
const NAV_OWNER: Array<{ to: string; icon: string; label: string }> = [
  { to: "/app/home", icon: "⌂", label: "Tổng quan" },
  { to: "/app/objectives", icon: "◎", label: "Mục tiêu" },
  { to: "/app/missions", icon: "▶", label: "Công việc" },
  { to: "/app/inbox", icon: "◉", label: "Phê duyệt" },
  { to: "/app/workforce", icon: "◍", label: "Nhân sự AI" },
];
const NAV_ADVANCED: Array<{ to: string; icon: string; label: string }> = [
  { to: "/app/new", icon: "✦", label: "Tạo bằng ngôn ngữ" },
  { to: "/app/company", icon: "◆", label: "Company Cockpit" },
  { to: "/app/ceo", icon: "◈", label: "CEO Workspace" },
  { to: "/app/workforce/admin", icon: "◐", label: "Workforce Admin" },
  { to: "/app/chat", icon: "◌", label: "Chat" },
  { to: "/app/system/business-admin", icon: "▣", label: "Business Admin" },
  { to: "/app/system/providers", icon: "▦", label: "Providers & Models" },
  { to: "/app/system/observability", icon: "◔", label: "Observability" },
  { to: "/app/system/schedules", icon: "◷", label: "Schedules" },
  { to: "/app/system/cost", icon: "◠", label: "Chi phí" },
  { to: "/app/system/settings", icon: "⚙", label: "Settings" },
];

const MODE_KEY = "pair.owner_mode";
export type ShellMode = "owner" | "advanced";
export function getShellMode(): ShellMode {
  return localStorage.getItem(MODE_KEY) === "advanced" ? "advanced" : "owner";
}
function setShellMode(m: ShellMode) {
  localStorage.setItem(MODE_KEY, m);
}

const CRUMB: Array<[string, string]> = [
  ["/app/home", "Tổng quan"],
  ["/app/new", "Tạo bằng ngôn ngữ"],
  ["/app/company", "Company Cockpit"],
  ["/app/inbox", "Phê duyệt"],
  ["/app/objectives", "Mục tiêu"],
  ["/app/ceo", "CEO Workspace"],
  ["/app/workforce/admin", "Workforce Admin"],
  ["/app/system/business-admin", "Business Admin"],
  ["/app/workforce", "Nhân sự AI"],
  ["/app/missions", "Công việc"],
  ["/app/chat", "Chat"],
  ["/app/system/providers", "Providers & Models"],
  ["/app/system/observability", "Observability"],
  ["/app/system/schedules", "Schedules"],
  ["/app/system/cost", "Chi phí"],
  ["/app/system/settings", "Settings"],
];

function crumbFor(pathname: string): string {
  const hit = CRUMB.find(([p]) => pathname === p || pathname.startsWith(p + "/"));
  return hit?.[1] ?? "Company OS";
}

function BusinessSwitcher() {
  const { biz, select } = useSelectedBusiness();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(biz);
  return (
    <div className="bizswitch">
      <button
        className="cur"
        onClick={() => {
          setDraft(biz);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-label="business switcher"
        title="Selected business"
      >
        <span className={`v${biz ? "" : " none"}`}>{biz || "no business selected"}</span>
        <span aria-hidden>▾</span>
      </button>
      {open ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            select(draft);
            setOpen(false);
          }}
        >
          <input
            aria-label="business id"
            placeholder="business_id"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="tbtn" type="submit">Use</button>
        </form>
      ) : null}
      <div className="hint">
        Enter a business_id manually — access is proven on read (403 = denied).
      </div>
    </div>
  );
}

function OperatorChip() {
  /* B5.5 Settings E2 — the chip reflects a saved operator id immediately,
     not just on next mount. */
  const [op, setOp] = useState(getOperatorId);
  useEffect(() => {
    const sync = () => setOp(getOperatorId());
    window.addEventListener("pair.operator-changed", sync);
    return () => window.removeEventListener("pair.operator-changed", sync);
  }, []);
  const label = op || "no operator";
  const initials = (op.replace(/^operator:/, "").slice(0, 2) || "?").toUpperCase();
  return (
    <span className="opchip" title={`operator: ${label}`}>
      <span className="av" aria-hidden>{initials}</span>
      <span className="name">{label}</span>
    </span>
  );
}


/* P15.9-B4 R1 — Inbox counts context: ONE pair of canonical reads
   (global approvals + company targets_met_pending) feeds every badge
   render — sidebar, mobile tab bar, drawer. A successful inbox
   mutation calls invalidateInboxCounts() → epoch bump → fresh
   canonical refetch; never an optimistic local decrement. When a
   business isn't selected the reviews half is unknowable → partial
   marker; any failed read → unavailable state, never a fake zero. */
/* R2-F1/R3-F1 — resolved state is BOUND to the exact request lifecycle
   that produced it: business identity + a monotonically increasing
   lifecycle generation (reqGen, bumped synchronously during render on
   EVERY business transition — closing the A→B→A reuse hole) + the
   inbox-invalidation generation (epoch). The render boundary
   synchronously suppresses any resolution not produced by the CURRENT
   lifecycle, so stale counts never repaint after switches, a late or
   aborted response can never overwrite a newer generation, and a
   previous generation never displays during an invalidation refetch. */
type InboxCountsResolved =
  | { kind: "ok"; count: number; partial: boolean; forBiz: string; forReq: number; forEpoch: number }
  | { kind: "unavailable"; forBiz: string; forReq: number; forEpoch: number };

type InboxCountsView = {
  resolved: InboxCountsResolved | null;
  biz: string;
  reqGen: number;
  epoch: number;
};

const InboxCountsContext = createContext<InboxCountsView>({ resolved: null, biz: "", reqGen: 0, epoch: 0 });
export function useInboxCounts() {
  return useContext(InboxCountsContext);
}

function InboxCountsProvider(props: { children: ReactNode }) {
  const { biz } = useSelectedBusiness();
  const [resolved, setResolved] = useState<InboxCountsResolved | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [reqGen, setReqGen] = useState(0);
  const [lastBiz, setLastBiz] = useState(biz);

  /* New business = a NEW lifecycle, even when the identity cycles back
     (A→B→A). Render-time derived state — legal React pattern — so the
     generation and the render guard update in the same commit as the
     biz change, with no one-frame stale window. */
  if (lastBiz !== biz) {
    setLastBiz(biz);
    setReqGen((n) => n + 1);
  }

  useEffect(() => onInboxInvalidate(() => setEpoch((n) => n + 1)), []);

  /* B5.5 R1-F3 — credential changes are credential-scoped invalidation:
     a saved operator id or a saved/cleared token bumps the epoch, so a
     resolution fetched under the previous credential can never repaint
     (its forEpoch is stale at the render boundary) and the badge
     refetches under the new header. */
  useEffect(() => {
    const bump = () => setEpoch((n) => n + 1);
    window.addEventListener("pair.operator-changed", bump);
    window.addEventListener("pair.credentials-changed", bump);
    return () => {
      window.removeEventListener("pair.operator-changed", bump);
      window.removeEventListener("pair.credentials-changed", bump);
    };
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    const reads: Array<Promise<void>> = [];
    let n = 0;
    let failed = false;
    const bump = (d: number) => { n += d; };
    reads.push(
      api.approvalsNoPrompt()
        .then((a) => bump((Array.isArray(a) ? a : []).filter((x) => x.status === "PENDING").length))
        .catch(() => { failed = true; }),
    );
    if (biz) {
      reads.push(
        api.businessCompany(biz, ctl.signal)
          .then((r) => bump(r.company.counts.targets_met_pending))
          .catch(() => { failed = true; }),
      );
    }
    const partial = !biz;
    const gen = reqGen;
    const gen2 = epoch;
    const bizAtFetch = biz;
    Promise.allSettled(reads).then(() => {
      if (ctl.signal.aborted) return;
      setResolved(failed
        ? { kind: "unavailable", forBiz: bizAtFetch, forReq: gen, forEpoch: gen2 }
        : { kind: "ok", count: n, partial, forBiz: bizAtFetch, forReq: gen, forEpoch: gen2 });
    });
    return () => ctl.abort();
  }, [biz, reqGen, epoch]);

  return (
    <InboxCountsContext.Provider value={{ resolved, biz, reqGen, epoch }}>
      {props.children}
    </InboxCountsContext.Provider>
  );
}

function InboxBadge() {
  const c = useInboxCounts();
  /* Synchronous render-boundary guard — only the resolution produced
     by the CURRENT request lifecycle may paint. */
  const live =
    c.resolved !== null &&
    c.resolved.forBiz === c.biz &&
    c.resolved.forReq === c.reqGen &&
    c.resolved.forEpoch === c.epoch
      ? c.resolved
      : null;
  return (
    <span className="ibadge-live" aria-live="polite">
      {live === null ? null : live.kind === "unavailable" ? (
        <span className="ibadge un" title="inbox count unavailable — a lane failed to load">!</span>
      ) : live.partial ? (
        <span className="ibadge un" title="approvals only — no business selected, reviews uncounted">{live.count}+</span>
      ) : (
        <span className="ibadge" title={`${live.count} items need owner attention`}>{live.count}</span>
      )}
    </span>
  );
}

function NavItem({ it, onNavigate }: { it: { to: string; icon: string; label: string }; onNavigate?: () => void }) {
  return (
    <NavLink
      to={it.to}
      end={it.to === "/app/home"}
      onClick={onNavigate}
      aria-label={it.label}
      title={it.label}
    >
      <span className="ico" aria-hidden>{it.icon}</span>
      <span className="lbl">{it.label}</span>
      {it.to === "/app/inbox" ? <InboxBadge /> : null}
    </NavLink>
  );
}

function NavLinks(props: { onNavigate?: () => void }) {
  /* Advanced group is collapsible in Owner mode and always reachable —
     Advanced mode just defaults it open. Presentation only. */
  const [mode] = useState<ShellMode>(getShellMode);
  const [advOpen, setAdvOpen] = useState(mode === "advanced");
  useEffect(() => {
    const sync = () => {
      if (getShellMode() === "advanced") setAdvOpen(true);
    };
    window.addEventListener("pair.shell-mode-changed", sync);
    return () => window.removeEventListener("pair.shell-mode-changed", sync);
  }, []);
  return (
    <>
      {NAV_OWNER.map((it) => (
        <NavItem key={it.to} it={it} onNavigate={props.onNavigate} />
      ))}
      <div className="group">
        <button
          type="button"
          className="advtoggle"
          aria-expanded={advOpen}
          onClick={() => setAdvOpen((o) => !o)}
        >
          Nâng cao <span aria-hidden>{advOpen ? "▾" : "▸"}</span>
        </button>
      </div>
      {/* Always in the DOM — CSS collapses it in Owner mode on wide
         screens; the icon rail and the mobile drawer force it open so
         no destination is ever unreachable (audit-grade rule). */}
      <div className={`advitems${advOpen ? " open" : ""}`}>
        {NAV_ADVANCED.map((it) => (
          <NavItem key={it.to} it={it} onNavigate={props.onNavigate} />
        ))}
      </div>
    </>
  );
}

export function AppShell() {
  const [theme, toggleTheme] = useTheme();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [biz, setBiz] = useState(getBusinessId);
  const [shellMode, setShellModeState] = useState<ShellMode>(getShellMode);
  const switchMode = (m: ShellMode) => {
    setShellMode(m);
    setShellModeState(m);
    window.dispatchEvent(new Event("pair.shell-mode-changed"));
  };
  const select = (id: string) => {
    setBusinessId(id);
    setBiz(getBusinessId());
  };
  const panelRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  // Modal keyboard behavior (B1 audit F2): focus enters the drawer on
  // open, Escape/close returns focus to the More trigger, Tab cycles
  // within the panel.
  useEffect(() => {
    if (!drawer) return;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setDrawer(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (!active || active === first || !panel?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!active || active === last || !panel?.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [drawer]);

  const wasDrawerOpen = useRef(false);
  useEffect(() => {
    if (wasDrawerOpen.current && !drawer) moreRef.current?.focus();
    wasDrawerOpen.current = drawer;
  }, [drawer]);
  return (
    <div className="appshell">
      <BizContext.Provider value={{ biz, select }}>
      <InboxCountsProvider>
      <aside className="aside">
        <a className="skip" href="#app-main">Skip to content</a>
        <div className="brand">
          <span className="dot">▮</span>
          <span className="lbl">PAIRNEXT</span>
        </div>
        <BusinessSwitcher />
        <nav className="anav" aria-label="primary">
          <NavLinks />
        </nav>
        <div className="afoot">
          <OperatorChip />
          <button className="tbtn" onClick={toggleTheme} aria-label="toggle theme" title="Toggle dark/light">
            {theme === "dark" ? "☾" : "☀"}
          </button>
        </div>
      </aside>
      <div className="acontent">
        <header className="atopbar">
          <span className="crumb">
            PAIRNEXT / <b>{crumbFor(loc.pathname)}</b>
          </span>
          {/* Tablet only (768–1199): rail hides the sidebar switcher,
              so the same manual-entry switcher lives here (F1). */}
          <div className="atobiz">
            <BusinessSwitcher />
          </div>
          <div className="atopright">
            <NavLink className="v2btn small" to="/app/new">+ Tạo mới</NavLink>
            <button
              type="button"
              className="tbtn modechip"
              title="Owner/Nâng cao — chỉ đổi mức hiển thị, quyền hạn giữ nguyên"
              aria-label="chuyển chế độ hiển thị"
              onClick={() => switchMode(shellMode === "owner" ? "advanced" : "owner")}
            >
              {shellMode === "owner" ? "Chế độ Owner" : "Nâng cao"}
            </button>
          </div>
        </header>
        <main className="amain" id="app-main">
          <Outlet />
        </main>
      </div>
      <nav className="atabbar" aria-label="primary mobile">
        <NavLink to="/app/home"><span className="ico">⌂</span>Tổng quan</NavLink>
        <NavLink to="/app/inbox"><span className="ico">◉</span>Phê duyệt<InboxBadge /></NavLink>
        <NavLink to="/app/objectives"><span className="ico">◎</span>Mục tiêu</NavLink>
        <NavLink to="/app/missions"><span className="ico">▶</span>Công việc</NavLink>
        <button type="button" ref={moreRef} onClick={() => setDrawer(true)} aria-label="more navigation" aria-haspopup="dialog">
          <span className="ico">☰</span>Thêm
        </button>
      </nav>
      {drawer ? (
        <div className="adrawer" role="dialog" aria-modal="true" aria-label="More navigation"
          onClick={() => setDrawer(false)}>
          <div className="panel" ref={panelRef} onClick={(e) => e.stopPropagation()}>
            <div className="dhead">
              <span className="grab">All sections</span>
              <button type="button" className="tbtn" aria-label="close navigation menu" onClick={() => setDrawer(false)}>
                ✕
              </button>
            </div>
            <BusinessSwitcher />
            <nav className="anav" aria-label="drawer">
              <NavLinks onNavigate={() => setDrawer(false)} />
            </nav>
            <div className="afoot" style={{ padding: "8px 16px" }}>
              <OperatorChip />
              <button className="tbtn" onClick={toggleTheme} aria-label="toggle theme">
                {theme === "dark" ? "☾" : "☀"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <Toasts />
      </InboxCountsProvider>
      </BizContext.Provider>
    </div>
  );
}
