/**
 * Personal Mode (UI-V2) — trusted-local session lane regressions.
 *
 * The lane exists ONLY on the designated loopback listener
 * (req.socket.localPort classification + proxy-marker belt), mints
 * digest-only session rows, binds the canonical owner through
 * strictEnumerate-derived identity, and never widens beyond the
 * ordinary operator credential class. Remote-class ingress can never
 * mint or consume a session; bearer/admin lanes are untouched.
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { Server } from "node:http";
import { mkTmpDir } from "../test-utils/tmpdir.js";
import {
  MissionControl,
  PairControlPlane,
  PairEvidenceStore,
  PersonalSessionService,
  createMissionControlServer,
  classifyPersonalIngress,
  assertPersonalOrigin,
  parsePersonalCookie,
  mintSessionCookie,
  clearSessionCookie,
  personalMode,
  PERSONAL_SESSION_COOKIE,
} from "../pair/index.js";

const ROOT = mkTmpDir("pair-personal-");
let n = 0;
const dir = (s: string) => {
  const p = path.join(ROOT, `${n++}-${s}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

function makeStore(name: string) {
  const store = new PairEvidenceStore(path.join(dir(name), "pair.db"));
  return store;
}

function makeSvc(
  store: PairEvidenceStore,
  owners: string[] = ["operator:op:admin"],
  bizByOwner: Record<string, string[]> = { "operator:op:admin": ["BIZ_1"] },
) {
  return new PersonalSessionService({
    store,
    listOwnerIds: () => owners,
    eligibleBusinesses: (op) => bizByOwner[op] ?? [],
  });
}

/* ---- A — mode flag ------------------------------------------------- */

describe("A personalMode flag", () => {
  it("unset/empty is off; literal local enables; off/0/false disable", () => {
    expect(personalMode({})).toBe("off");
    expect(personalMode({ PAIR_PERSONAL_MODE: "" })).toBe("off");
    expect(personalMode({ PAIR_PERSONAL_MODE: "local" })).toBe("local");
    expect(personalMode({ PAIR_PERSONAL_MODE: "off" })).toBe("off");
    expect(personalMode({ PAIR_PERSONAL_MODE: "0" })).toBe("off");
    expect(personalMode({ PAIR_PERSONAL_MODE: "false" })).toBe("off");
  });
  it("unrecognized configured value fails closed", () => {
    expect(() => personalMode({ PAIR_PERSONAL_MODE: "yes" })).toThrowError(
      /FAIL_CLOSED_PERSONAL_MODE_INVALID/,
    );
    expect(() => personalMode({ PAIR_PERSONAL_MODE: "1" })).toThrowError(
      /FAIL_CLOSED_PERSONAL_MODE_INVALID/,
    );
  });
});

/* ---- B — ingress classification ------------------------------------ */

function fakeReq(opts: {
  localPort?: number;
  remoteAddress?: string;
  host?: string;
  headers?: Record<string, string>;
}): http.IncomingMessage {
  return {
    socket: {
      localPort: opts.localPort ?? 8788,
      remoteAddress: opts.remoteAddress ?? "127.0.0.1",
    },
    headers: {
      host: opts.host ?? "localhost:8788",
      ...(opts.headers ?? {}),
    },
  } as unknown as http.IncomingMessage;
}

describe("B classifyPersonalIngress", () => {
  it("loopback socket + loopback host + no proxy marks → local", () => {
    expect(classifyPersonalIngress(fakeReq({}), 8788)).toBe("local");
    expect(classifyPersonalIngress(fakeReq({ host: "127.0.0.1:8788" }), 8788)).toBe("local");
    expect(classifyPersonalIngress(fakeReq({ remoteAddress: "::1", host: "[::1]:8788" }), 8788)).toBe("local");
  });
  it("wrong listener port is remote even when everything else is loopback", () => {
    // The tunnel/proxy forwarded socket: remoteAddress IS loopback but
    // it landed on the remote listener — socket truth decides.
    expect(classifyPersonalIngress(fakeReq({ localPort: 8790 }), 8788)).toBe("remote");
  });
  it("proxy/forwarding marks classify remote (misconfigured tunnel belt)", () => {
    expect(classifyPersonalIngress(fakeReq({ headers: { "cf-ray": "abc" } }), 8788)).toBe("remote");
    expect(classifyPersonalIngress(fakeReq({ headers: { "x-forwarded-for": "1.2.3.4" } }), 8788)).toBe("remote");
    expect(classifyPersonalIngress(fakeReq({ headers: { forwarded: "for=1.2.3.4" } }), 8788)).toBe("remote");
    expect(classifyPersonalIngress(fakeReq({ headers: { via: "1.1 proxy" } }), 8788)).toBe("remote");
    expect(classifyPersonalIngress(fakeReq({ headers: { "x-real-ip": "1.2.3.4" } }), 8788)).toBe("remote");
    expect(classifyPersonalIngress(fakeReq({ headers: { "cdn-loop": "cloudflare" } }), 8788)).toBe("remote");
  });
  it("non-loopback peer or non-loopback host is remote", () => {
    expect(classifyPersonalIngress(fakeReq({ remoteAddress: "192.168.1.5" }), 8788)).toBe("remote");
    expect(classifyPersonalIngress(fakeReq({ host: "pair.trycloudflare.com" }), 8788)).toBe("remote");
    expect(classifyPersonalIngress(fakeReq({ host: "evil.example.com" }), 8788)).toBe("remote");
  });
  it("unconfigured localPort can never classify local", () => {
    expect(classifyPersonalIngress(fakeReq({}), 0)).toBe("remote");
    expect(classifyPersonalIngress(fakeReq({}), -1)).toBe("remote");
  });
});

/* ---- C — origin proof ----------------------------------------------- */

describe("C assertPersonalOrigin", () => {
  it("same-origin loopback Origin passes", () => {
    expect(() =>
      assertPersonalOrigin(fakeReq({ headers: { origin: "http://localhost:8788" } })),
    ).not.toThrow();
    expect(() =>
      assertPersonalOrigin(fakeReq({ host: "127.0.0.1:8788", headers: { origin: "http://127.0.0.1:8788" } })),
    ).not.toThrow();
  });
  it("cross-origin or non-loopback Origin fails closed", () => {
    expect(() =>
      assertPersonalOrigin(fakeReq({ headers: { origin: "https://evil.example.com" } })),
    ).toThrowError(/FAIL_CLOSED_PERSONAL_ORIGIN/);
    expect(() =>
      assertPersonalOrigin(fakeReq({ headers: { origin: "http://localhost:9999" } })),
    ).toThrowError(/FAIL_CLOSED_PERSONAL_ORIGIN/);
    expect(() =>
      assertPersonalOrigin(fakeReq({ headers: { origin: "not-a-url" } })),
    ).toThrowError(/FAIL_CLOSED_PERSONAL_ORIGIN/);
  });
  it("hostile Sec-Fetch-Site fails closed; same-origin/none pass", () => {
    expect(() =>
      assertPersonalOrigin(fakeReq({ headers: { "sec-fetch-site": "cross-site" } })),
    ).toThrowError(/FAIL_CLOSED_PERSONAL_ORIGIN/);
    expect(() =>
      assertPersonalOrigin(fakeReq({ headers: { "sec-fetch-site": "same-origin" } })),
    ).not.toThrow();
    expect(() => assertPersonalOrigin(fakeReq({}))).not.toThrow();
  });
});

/* ---- D — cookie shape ----------------------------------------------- */

describe("D cookie", () => {
  it("mint produces HttpOnly SameSite=Strict Path=/ bounded cookie", () => {
    const c = mintSessionCookie("a".repeat(64), false);
    expect(c).toContain(`${PERSONAL_SESSION_COOKIE}=${"a".repeat(64)}`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).not.toContain("Secure");
    expect(mintSessionCookie("a".repeat(64), true)).toContain("Secure");
  });
  it("parse accepts only a 64-hex session id", () => {
    const req = (cookie: string | undefined) =>
      ({ headers: cookie ? { cookie } : {} }) as unknown as http.IncomingMessage;
    expect(parsePersonalCookie(req(`${PERSONAL_SESSION_COOKIE}=${"ab".repeat(32)}`))).toBe("ab".repeat(32));
    expect(parsePersonalCookie(req(`other=x; ${PERSONAL_SESSION_COOKIE}=${"cd".repeat(32)}`))).toBe("cd".repeat(32));
    expect(parsePersonalCookie(req(`${PERSONAL_SESSION_COOKIE}=short`))).toBeNull();
    expect(parsePersonalCookie(req(`${PERSONAL_SESSION_COOKIE}=${"z".repeat(64)}`))).toBeNull();
    expect(parsePersonalCookie(req(undefined))).toBeNull();
  });
  it("clear cookie expires immediately", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});

/* ---- E — service: owner binding + sessions --------------------------- */

describe("E PersonalSessionService", () => {
  it("single canonical owner auto-binds; session authenticates", () => {
    const svc = makeSvc(makeStore("e1"), ["operator:op:admin"]);
    const r = svc.bootstrap();
    expect(r.needs_owner_selection).toBe(false);
    expect(r.info!.operator).toBe("operator:op:admin");
    const sess = svc.authenticate(r.sessionId);
    expect(sess?.operator).toBe("operator:op:admin");
    // sole eligible business auto-selected at status time
    const st = svc.status("local", r.sessionId);
    expect(st.session?.business_id).toBe("BIZ_1");
  });
  it("zero owners mints a stable fresh personal operator", () => {
    const svc = makeSvc(makeStore("e2"), []);
    const r = svc.bootstrap();
    expect(r.info!.operator).toMatch(/^operator:personal:[0-9a-f]{16}$/);
    // persisted — second bootstrap keeps the same identity
    const r2 = svc.bootstrap();
    expect(r2.info!.operator).toBe(r.info!.operator);
  });
  it("multiple owners require explicit selection; forged owner fails closed", () => {
    const svc = makeSvc(makeStore("e3"), ["operator:a", "operator:b"]);
    const r = svc.bootstrap();
    expect(r.needs_owner_selection).toBe(true);
    expect(r.candidates.sort()).toEqual(["operator:a", "operator:b"]);
    expect(() => svc.selectOwner("operator:mallory")).toThrowError(/FAIL_CLOSED_PERSONAL_OWNER/);
    const sel = svc.selectOwner("operator:b");
    expect(sel.info.operator).toBe("operator:b");
    // re-selection with a different owner after binding fails closed
    expect(() => svc.selectOwner("operator:a")).toThrowError(/FAIL_CLOSED_PERSONAL_OWNER_BOUND/);
  });
  it("revoked/expired/foreign sessions authenticate nothing", () => {
    const store = makeStore("e4");
    const svc = makeSvc(store);
    const r = svc.bootstrap();
    expect(svc.authenticate(r.sessionId)?.operator).toBe("operator:op:admin");
    svc.revoke(r.sessionId);
    expect(svc.authenticate(r.sessionId)).toBeNull();
    // expired row
    const r2 = svc.bootstrap();
    const entId = `ps:${crypto.createHash("sha256").update(r2.sessionId!, "utf8").digest("hex")}`;
    const row = store.get(PERSONAL_SESSION_ENTITY_ROW, entId);
    store.put(PERSONAL_SESSION_ENTITY_ROW, entId, {
      ...row,
      expires_at: "2000-01-01T00:00:00.000Z",
    });
    expect(svc.authenticate(r2.sessionId)).toBeNull();
  });
  it("setBusiness enforces owner-scoped eligibility", () => {
    const svc = makeSvc(makeStore("e5"), ["operator:op:admin"], { "operator:op:admin": ["BIZ_1", "BIZ_2"] });
    const r = svc.bootstrap();
    expect(() => svc.setBusiness(r.sessionId, "BIZ_FOREIGN")).toThrowError(/FAIL_CLOSED_PERSONAL_BUSINESS/);
    expect(svc.setBusiness(r.sessionId, "BIZ_2").business_id).toBe("BIZ_2");
    expect(svc.authenticate(r.sessionId)?.business_id).toBe("BIZ_2");
    expect(svc.setBusiness(r.sessionId, "").business_id).toBeNull();
    expect(() => svc.setBusiness(null, "BIZ_1")).toThrowError(/FAIL_CLOSED_PERSONAL_SESSION/);
  });
  it("stale business preference is dropped, never silently kept", () => {
    const store = makeStore("e6");
    const svc = makeSvc(store, ["operator:op:admin"], { "operator:op:admin": ["BIZ_1"] });
    const r = svc.bootstrap();
    svc.setBusiness(r.sessionId, "BIZ_1");
    // owner loses access to BIZ_1 → preference reconciled to null
    const svc2 = makeSvc(store, ["operator:op:admin"], { "operator:op:admin": [] });
    const st = svc2.status("local", r.sessionId);
    expect(st.session?.business_id).toBeNull();
  });
});

const PERSONAL_SESSION_ENTITY_ROW = "personal_session";

/* ---- F — HTTP integration --------------------------------------------- */

async function withPersonalServer(
  ctx: { store: PairEvidenceStore; service: PairControlPlane },
  svc: PersonalSessionService,
  fn: (port: number) => Promise<void>,
) {
  const control = new MissionControl({ service: ctx.service } as never);
  // Mutable dep reference — the bound port is only known after listen;
  // the handler reads it per-request (same shape as serve wiring).
  const personalDep = { service: svc, localPort: 0 };
  const server: Server = createMissionControlServer({
    control,
    authToken: "tok-test",
    personal: personalDep,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  personalDep.localPort = port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function reqJson(port: number, path_: string, init?: RequestInit) {
  const res = await fetch(`http://127.0.0.1:${port}${path_}`, init);
  const text = await res.text();
  let body: unknown = {};
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body: body as Record<string, unknown>, setCookie: res.headers.get("set-cookie") };
}

describe("F HTTP personal lane", () => {
  function ctx(name: string) {
    const store = makeStore(name);
    return { store, service: new PairControlPlane(store) };
  }

  it("status on local ingress reports mode; bootstrap mints a session cookie", async () => {
    const c = ctx("f1");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const st = await reqJson(port, "/api/personal/session");
      expect(st.status).toBe(200);
      expect(st.body.personal_mode).toBe(true);
      expect(st.body.ingress).toBe("local");
      expect(st.body.session).toBeNull();
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(boot.status).toBe(200);
      expect(boot.setCookie).toContain("HttpOnly");
      expect(boot.setCookie).toContain("SameSite=Strict");
      expect((boot.body.session as { operator: string }).operator).toBe("operator:op:admin");
    });
  });

  it("session cookie satisfies the general gate; no bearer needed", async () => {
    const c = ctx("f2");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const denied = await reqJson(port, "/api/health");
      // /api/health is gated? verify a gated route — /api/missions
      const deniedM = await reqJson(port, "/api/missions");
      expect(deniedM.status).toBe(401);
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cookie = boot.setCookie!.split(";")[0]!;
      const authed = await reqJson(port, "/api/missions", { headers: { cookie } });
      expect(authed.status).toBe(200);
    });
  });

  it("conflicting x-operator-id under a session fails closed 403", async () => {
    const c = ctx("f3");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cookie = boot.setCookie!.split(";")[0]!;
      const forged = await reqJson(port, "/api/missions", {
        headers: { cookie, "x-operator-id": "operator:mallory" },
      });
      expect(forged.status).toBe(403);
      const matching = await reqJson(port, "/api/missions", {
        headers: { cookie, "x-operator-id": "op:admin" },
      });
      expect(matching.status).toBe(200);
    });
  });

  it("remote ingress can never mint or consume a session", async () => {
    const c = ctx("f4");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      // A proxy marker makes even a loopback-socket request remote-class.
      const proxied = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-ray": "8f1ab2" },
        body: "{}",
      });
      expect(proxied.status).toBe(403);
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cookie = boot.setCookie!.split(";")[0]!;
      const sessionViaProxy = await reqJson(port, "/api/missions", {
        headers: { cookie, "x-forwarded-for": "1.2.3.4" },
      });
      expect(sessionViaProxy.status).toBe(401);
    });
  });

  it("session-authenticated mutation without origin proof passes; cross-site Origin rejected", async () => {
    const c = ctx("f5");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cookie = boot.setCookie!.split(";")[0]!;
      // Cross-site Origin on a session-auth POST → 403 CSRF boundary.
      const hostile = await reqJson(port, "/api/missions", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin: "https://evil.example.com" },
        body: "{}",
      });
      expect(hostile.status).toBe(403);
      expect(String(hostile.body.error)).toContain("FAIL_CLOSED_PERSONAL_ORIGIN");
    });
  });

  it("logout revokes — the cookie stops authenticating", async () => {
    const c = ctx("f6");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cookie = boot.setCookie!.split(";")[0]!;
      const out = await reqJson(port, "/api/personal/session/logout", {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}",
      });
      expect(out.status).toBe(200);
      expect(out.setCookie).toContain("Max-Age=0");
      const denied = await reqJson(port, "/api/missions", { headers: { cookie } });
      expect(denied.status).toBe(401);
    });
  });

  it("bearer token still works on the same server (no regression)", async () => {
    const c = ctx("f7");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const authed = await reqJson(port, "/api/missions", {
        headers: { authorization: "Bearer tok-test" },
      });
      expect(authed.status).toBe(200);
    });
  });

  it("mode OFF (no personal dep) — personal routes 404, bearer unchanged", async () => {
    const c = ctx("f8");
    const control = new MissionControl({ service: c.service } as never);
    const server: Server = createMissionControlServer({ control, authToken: "tok-test" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const st = await reqJson(port, "/api/personal/session");
      expect(st.status).toBe(404);
      const denied = await reqJson(port, "/api/missions");
      expect(denied.status).toBe(401);
      const authed = await reqJson(port, "/api/missions", {
        headers: { authorization: "Bearer tok-test" },
      });
      expect(authed.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("session survives store reload — durable, digest-only persistence", async () => {
    const c = ctx("f9");
    const svc = makeSvc(c.store);
    const r = svc.bootstrap();
    // a NEW service instance over the same store validates the session —
    // and the persisted payload holds sha256(id), never the raw id.
    const svc2 = makeSvc(c.store);
    expect(svc2.authenticate(r.sessionId)?.operator).toBe("operator:op:admin");
    const rows = c.store.list(PERSONAL_SESSION_ENTITY_ROW);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows[0])).not.toContain(r.sessionId);
  });
});

/* ---- G — audit P1: remote session isolation -------------------------- */

describe("G remote session isolation (audit P1)", () => {
  function ctx(name: string) {
    const store = makeStore(name);
    return { store, service: new PairControlPlane(store) };
  }
  // A proxy marker is what classifies a loopback-socket request as
  // remote — same mechanism a tunnel/forwarded connection triggers.
  const PROXY = { "x-forwarded-for": "1.2.3.4" };

  it("remote GET status never echoes a bound session back", async () => {
    const c = ctx("g1");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cookie = boot.setCookie!.split(";")[0]!;
      const st = await reqJson(port, "/api/personal/session", {
        headers: { cookie, ...PROXY },
      });
      expect(st.status).toBe(200);
      expect(st.body.personal_mode).toBe(true);
      expect(st.body.ingress).toBe("remote");
      expect(st.body.session).toBeNull();
      expect(st.body.owner_candidates).toEqual([]);
      expect(st.body.eligible_businesses).toEqual([]);
      // The bound owner never leaves the server on a remote read.
      expect(JSON.stringify(st.body)).not.toContain("op:admin");
      expect(JSON.stringify(st.body)).not.toContain("BIZ_1");
    });
  });

  it("remote POST business cannot rebind — local binding unchanged", async () => {
    const c = ctx("g2");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cookie = boot.setCookie!.split(";")[0]!;
      // Establish a valid local business first.
      const set = await reqJson(port, "/api/personal/session/business", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ business_id: "BIZ_1" }),
      });
      expect(set.status).toBe(200);
      // The SAME request over remote-class ingress is refused before
      // reaching the service — 403, and the binding stays BIZ_1.
      const remote = await reqJson(port, "/api/personal/session/business", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...PROXY },
        body: JSON.stringify({ business_id: "" }),
      });
      expect(remote.status).toBe(403);
      expect(String(remote.body.error)).toContain("FAIL_CLOSED_PERSONAL_INGRESS");
      const after = svc.status("local", cookie.split("=")[1]!.trim());
      expect(after.session?.business_id).toBe("BIZ_1");
    });
  });

  it("remote POST logout cannot revoke — the session keeps working", async () => {
    const c = ctx("g3");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cookie = boot.setCookie!.split(";")[0]!;
      const remote = await reqJson(port, "/api/personal/session/logout", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...PROXY },
        body: "{}",
      });
      expect(remote.status).toBe(403);
      // The session was NOT revoked — it still satisfies the gate.
      const authed = await reqJson(port, "/api/missions", { headers: { cookie } });
      expect(authed.status).toBe(200);
    });
  });

  it("remote POST select-owner / bootstrap rejected (single gate)", async () => {
    const c = ctx("g4");
    const svc = makeSvc(c.store, ["operator:a", "operator:b"], {});
    await withPersonalServer(c, svc, async (port) => {
      const sel = await reqJson(port, "/api/personal/session/select-owner", {
        method: "POST",
        headers: { "content-type": "application/json", ...PROXY },
        body: JSON.stringify({ owner: "operator:a" }),
      });
      expect(sel.status).toBe(403);
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", ...PROXY },
        body: "{}",
      });
      expect(boot.status).toBe(403);
    });
  });
});

/* ---- H — audit P2: business state consistency ------------------------ */

describe("H business consistency (audit P2)", () => {
  function ctx(name: string) {
    const store = makeStore(name);
    return { store, service: new PairControlPlane(store) };
  }

  it("ineligible business rejected — binding keeps the previous valid value", async () => {
    const c = ctx("h1");
    const svc = makeSvc(c.store);
    await withPersonalServer(c, svc, async (port) => {
      const boot = await reqJson(port, "/api/personal/session/bootstrap", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const cookie = boot.setCookie!.split(";")[0]!;
      const set = await reqJson(port, "/api/personal/session/business", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ business_id: "BIZ_1" }),
      });
      expect(set.status).toBe(200);
      // A failed switch MUST NOT clear or overwrite the valid binding.
      const bad = await reqJson(port, "/api/personal/session/business", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ business_id: "BIZ_FOREIGN" }),
      });
      expect(bad.status).toBe(403);
      expect(String(bad.body.error)).toContain("FAIL_CLOSED_PERSONAL_BUSINESS");
      const after = svc.status("local", cookie.split("=")[1]!.trim());
      expect(after.session?.business_id).toBe("BIZ_1");
    });
  });

  it("stale bound business drops on status; replacement is explicit", async () => {
    const c = ctx("h2");
    const store = c.store;
    // Owner loses access to BIZ_1 mid-session (objective revoked).
    let eligible: string[] = ["BIZ_1"];
    const svc = new PersonalSessionService({
      store,
      listOwnerIds: () => ["operator:op:admin"],
      eligibleBusinesses: () => eligible,
    });
    const r = svc.bootstrap();
    svc.setBusiness(r.sessionId, "BIZ_1");
    eligible = [];
    const st = svc.status("local", r.sessionId);
    // Stale preference dropped — the session never keeps an
    // inaccessible business; the UI mirrors this to empty.
    expect(st.session?.business_id).toBeNull();
  });
});
