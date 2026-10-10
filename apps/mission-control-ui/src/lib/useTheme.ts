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
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
