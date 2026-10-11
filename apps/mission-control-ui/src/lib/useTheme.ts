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
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
