import { NavLink, Outlet, useLocation } from "react-router-dom";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { getOperatorId } from "../api";
import { useTheme } from "../lib/useTheme";
import { Toasts } from "../components/Toast";

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

const NAV: Array<{ group: string; items: Array<{ to: string; icon: string; label: string }> }> = [
  {
    group: "Overview",
    items: [
      { to: "/app/company", icon: "◆", label: "Company Cockpit" },
      { to: "/app/inbox", icon: "◉", label: "Owner Inbox" },
    ],
  },
  {
    group: "Business",
    items: [
      { to: "/app/objectives", icon: "◎", label: "Objectives" },
      { to: "/app/ceo", icon: "◈", label: "CEO Workspace" },
      { to: "/app/workforce", icon: "◍", label: "Workforce" },
    ],
  },
  {
    group: "Operations",
    items: [
      { to: "/app/missions", icon: "▶", label: "Missions" },
      { to: "/app/chat", icon: "◌", label: "Chat" },
    ],
  },
  {
    group: "System",
    items: [
      { to: "/app/system/providers", icon: "▦", label: "Providers & Models" },
      { to: "/app/system/observability", icon: "◔", label: "Observability" },
      { to: "/app/system/schedules", icon: "◷", label: "Schedules" },
      { to: "/app/system/cost", icon: "◠", label: "Cost" },
      { to: "/app/system/settings", icon: "⚙", label: "Settings" },
    ],
  },
];

const CRUMB: Array<[string, string]> = [
  ["/app/company", "Company Cockpit"],
  ["/app/inbox", "Owner Inbox"],
  ["/app/objectives", "Objectives"],
  ["/app/ceo", "CEO Workspace"],
  ["/app/workforce", "AI Workforce"],
  ["/app/missions", "Mission Operations"],
  ["/app/chat", "Chat"],
  ["/app/system/providers", "Providers & Models"],
  ["/app/system/observability", "Observability"],
  ["/app/system/schedules", "Schedules"],
  ["/app/system/cost", "Cost & Usage"],
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
  const op = getOperatorId();
  const label = op || "no operator";
  const initials = (op.replace(/^operator:/, "").slice(0, 2) || "?").toUpperCase();
  return (
    <span className="opchip" title={`operator: ${label}`}>
      <span className="av" aria-hidden>{initials}</span>
      <span className="name">{label}</span>
    </span>
  );
}

function NavLinks(props: { onNavigate?: () => void }) {
  return (
    <>
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="group">{g.group}</div>
          {g.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.to === "/app/company"}
              onClick={props.onNavigate}
              aria-label={it.label}
              title={it.label}
            >
              <span className="ico" aria-hidden>{it.icon}</span>
              <span className="lbl">{it.label}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </>
  );
}

export function AppShell() {
  const [theme, toggleTheme] = useTheme();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [biz, setBiz] = useState(getBusinessId);
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
      <aside className="aside">
        <a className="skip" href="#app-main">Skip to content</a>
        <div className="brand">
          <span className="dot">▮</span>
          <span className="lbl">PAIR · Company OS</span>
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
            PAIR / <b>{crumbFor(loc.pathname)}</b>
          </span>
          {/* Tablet only (768–1199): rail hides the sidebar switcher,
              so the same manual-entry switcher lives here (F1). */}
          <div className="atobiz">
            <BusinessSwitcher />
          </div>
        </header>
        <main className="amain" id="app-main">
          <Outlet />
        </main>
      </div>
      <nav className="atabbar" aria-label="primary mobile">
        <NavLink to="/app/company"><span className="ico">◆</span>Cockpit</NavLink>
        <NavLink to="/app/inbox"><span className="ico">◉</span>Inbox</NavLink>
        <NavLink to="/app/objectives"><span className="ico">◎</span>Objs</NavLink>
        <NavLink to="/app/missions"><span className="ico">▶</span>Miss</NavLink>
        <button type="button" ref={moreRef} onClick={() => setDrawer(true)} aria-label="more navigation" aria-haspopup="dialog">
          <span className="ico">☰</span>More
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
      </BizContext.Provider>
    </div>
  );
}
