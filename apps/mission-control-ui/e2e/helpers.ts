import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Shared e2e seed: the serve script resolves its MC bearer token from
 * PAIR_MC_TOKEN > $PAIR_HOME/pair-mc-token > ~/pair-mc-token. The UI
 * expects it in localStorage as pair.mc_token — seed the SAME value via
 * addInitScript (before any page fetch, so no 401 prompt can race). */
export function mcToken(): string {
  if (process.env.PAIR_MC_TOKEN) return process.env.PAIR_MC_TOKEN;
  const file = path.join(process.env.PAIR_HOME ?? os.homedir(), "pair-mc-token");
  return fs.readFileSync(file, "utf8").trim();
}

export async function seedSession(page: { addInitScript: (fn: (t: string) => void, arg: string) => Promise<unknown> }) {
  await page.addInitScript((t: string) => {
    localStorage.setItem("pair.mc_token", t);
    localStorage.setItem("pair.operator_id", "op:e2e");
  }, mcToken());
}
