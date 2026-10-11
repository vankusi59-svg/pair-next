import { useEffect, useState } from "react";

/* Shared theme hook — same `pair.theme` localStorage key + `data-theme`
   attribute contract as the legacy Layout, so theme carries over. */
export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(
    () =>
      localStorage.getItem("pair.theme") ??
      (window.matchMedia?.("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pair.theme", theme);
  }, [theme]);
  /* B5.5 Settings E3 — stay synchronized when the Settings control (or
     another tab) writes pair.theme. One source of truth: localStorage. */
  useEffect(() => {
    const sync = () => {
      const t = localStorage.getItem("pair.theme");
      if (t === "light" || t === "dark") setTheme(t);
    };
    window.addEventListener("pair.theme-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("pair.theme-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const toggle = () => {
    /* B5.5 R1-F2 — compute the next value from the shared source of
       truth (localStorage), not from this instance's possibly-stale
       state, so a stale consumer can never overwrite a newer selection
       and one toggle is always one actual transition. Then notify every
       other same-tab useTheme consumer via pair.theme-changed — the
       event they already listen for — keeping a single theme authority
       (no loops: listeners set the same value and React bails out). */
    const cur = localStorage.getItem("pair.theme") === "light" ? "light" : "dark";
    const next = cur === "dark" ? "light" : "dark";
    localStorage.setItem("pair.theme", next);
    setTheme(next);
    window.dispatchEvent(new Event("pair.theme-changed"));
  };
  return [theme, toggle];
}
