import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { getOperatorId, setOperatorId } from "../api";
import { Toasts } from "./Toast";

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(
    () =>
      localStorage.getItem("pair.theme") ??
      (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pair.theme", theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

export function Layout() {
  const [op, setOp] = useState(getOperatorId());
  const [theme, toggleTheme] = useTheme();
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <span className="brand">PAIR Mission Control</span>
        <nav aria-label="main">
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/approvals">Approvals</NavLink>
          <NavLink to="/schedules">Schedules</NavLink>
          <NavLink to="/providers">Providers</NavLink>
          <NavLink to="/observability">Observability</NavLink>
          <NavLink to="/missions/new">New Mission</NavLink>
        </nav>
        <button className="ghost" onClick={toggleTheme} aria-label="toggle theme" title="Toggle dark/light">
          {theme === "dark" ? "☾" : "☀"}
        </button>
        <div className="op">
          <label className="muted" htmlFor="opid">operator</label>
          <input
            id="opid"
            value={op}
            placeholder="operator id"
            onChange={(e) => {
              setOp(e.target.value);
              setOperatorId(e.target.value);
            }}
          />
        </div>
      </header>
      <main id="main">
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}
