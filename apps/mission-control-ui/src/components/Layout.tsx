import { NavLink, Outlet } from "react-router-dom";
import { useState } from "react";
import { getOperatorId, setOperatorId } from "../api";

export function Layout() {
  const [op, setOp] = useState(getOperatorId());
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">PAIR Mission Control</span>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/approvals">Approvals</NavLink>
          <NavLink to="/missions/new">New Mission</NavLink>
        </nav>
        <div className="op">
          <label className="muted">operator</label>
          <input
            value={op}
            placeholder="operator id"
            onChange={(e) => {
              setOp(e.target.value);
              setOperatorId(e.target.value);
            }}
          />
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
