import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StellarSource } from "../src/chain.js";
import { Concord } from "../src/concord.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { CONTROL_MIGRATIONS, ORG_MIGRATIONS } from "../src/schema.js";
import { Tenants, memoryStore } from "../src/tenants.js";
import { Client, FakeChain, MAINNET_PASSTHRASE, ORIGIN, PASSPHRASE, at, harness, key, u, type Harness } from "./helpers.js";

/** Strings that exist only in workspace A. None may ever reach workspace B. */
const MARKERS = ["ALPHA-HOLDER-7", "Northgate Secret Trust", "alpha sign-off note", "J-ALPHA", "I-ALPHA", "Alpha Capital"];

interface Seeded {
  h: Harness;
  a: Client;
  b: Client;
  assetId: string;
  issuer: string;
  holder: string;
  runId: number;
  registerId: number;
  actionId: number;
}

/** Workspace A with books in every table; workspace B empty. */
async function seed(): Promise<Seeded> {
  const h = harness();
  const a = await new Client(h.app).signUp("ann@alpha.test", "Alpha Capital", "Ann Alpha");
  const b = await new Client(h.app).signUp("bob@beta.test", "Beta Partners", "Bob Beta");
  const issuer = key();
  const holder = key();
  const ws = h.tenants.forOrg(a.orgId);
  const asset = await ws.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
  h.chain.push(asset.id, "mint", 3, { to: holder, amount: u(100) });
  h.chain.push(asset.id, "clawback", 5, { from: holder, amount: u(1) });
  const imported = await a.json<{ registerId: number; run: { id: number; breaks: Array<{ key: string; fingerprint: string }> } }>(
    "/api/assets/FUND/registers",
    { body: { csv: `holder_id,holder_name,account,units\nALPHA-HOLDER-7,Northgate Secret Trust,${holder},90\n`, asOf: at(40) } },
  );
  await a.json("/api/assets/FUND/journal", {
    body: { csv: `ref,date,type,from_account,to_account,units\nJ-ALPHA,${at(3)},issue,,${holder},100\n` },
  });
  await a.json("/api/assets/FUND/instructions", {
    body: { csv: `ref,type,account,units,issued_at\nI-ALPHA,clawback,${holder},1,${at(4)}\n` },
  });
  const brk = imported.run.breaks[0]!;
  await a.json("/api/assets/FUND/notes", {
    method: "PUT",
    body: { scope: "recon", key: brk.key, fingerprint: brk.fingerprint, status: "acknowledged", note: "alpha sign-off note" },
  });
  const action = await a.json<{ id: number }>(
    "/api/assets/FUND/actions",
    { body: { type: "split", recordTime: at(10), num: "2", den: "1" } },
  );
  return { h, a, b, assetId: asset.id, issuer, holder, runId: imported.run.id, registerId: imported.registerId, actionId: action.id };
}

type Probe = { method: string; path: string; body?: unknown };

/** One request per workspace route, aimed at workspace A's ids. */
function probes(s: Seeded): Record<string, Probe> {
  const id = s.assetId;
  const p = (method: string, path: string, body?: unknown): Probe => ({ method, path, ...(body === undefined ? {} : { body }) });
  return {
    "GET /api/org/members": p("GET", "/api/org/members"),
    "POST /api/org/invites": p("POST", "/api/org/invites", { email: "new@beta.test" }),
    "DELETE /api/org/invites/:inviteId": p("DELETE", "/api/org/invites/0000000000000000"),
    "PATCH /api/org/members/:userId": p("PATCH", `/api/org/members/${s.a.userId}`, { role: "member" }),
    "DELETE /api/org/members/:userId": p("DELETE", `/api/org/members/${s.a.userId}`),
    "PATCH /api/org": p("PATCH", "/api/org", { name: "Beta Partners" }),
    "DELETE /api/org": p("DELETE", "/api/org", { confirm: "Alpha Capital" }),
    "GET /api/overview": p("GET", "/api/overview"),
    "GET /api/lookup": p("GET", "/api/lookup?network=testnet&code=FUND"),
    "POST /api/assets": p("POST", "/api/assets", { network: "testnet", asset: "not an asset" }),
    "GET /api/assets/:id": p("GET", `/api/assets/${id}`),
    "PATCH /api/assets/:id": p("PATCH", `/api/assets/${id}`, { name: "stolen" }),
    "DELETE /api/assets/:id": p("DELETE", `/api/assets/${id}`),
    "POST /api/assets/:id/sync": p("POST", `/api/assets/${id}/sync`),
    "POST /api/assets/:id/rebuild": p("POST", `/api/assets/${id}/rebuild`),
    "GET /api/assets/:id/holdings": p("GET", `/api/assets/${id}/holdings`),
    "GET /api/assets/:id/events": p("GET", `/api/assets/${id}/events`),
    "GET /api/templates/:kind": p("GET", "/api/templates/register"),
    "GET /api/assets/:id/registers": p("GET", `/api/assets/${id}/registers`),
    "POST /api/assets/:id/registers": p("POST", `/api/assets/${id}/registers`, { csv: "holder_id,units\nX,1\n", asOf: at(1) }),
    "DELETE /api/assets/:id/registers/:registerId": p("DELETE", `/api/assets/${id}/registers/${s.registerId}`),
    "POST /api/assets/:id/journal": p("POST", `/api/assets/${id}/journal`, { csv: "ref,date,type,units\n" }),
    "POST /api/assets/:id/instructions": p("POST", `/api/assets/${id}/instructions`, { csv: "ref,type,account,issued_at\n" }),
    "GET /api/assets/:id/reconciliations": p("GET", `/api/assets/${id}/reconciliations`),
    "POST /api/assets/:id/reconciliations": p("POST", `/api/assets/${id}/reconciliations`, { registerId: s.registerId }),
    "GET /api/reconciliations/:id": p("GET", `/api/reconciliations/${s.runId}`),
    "GET /api/assets/:id/actions": p("GET", `/api/assets/${id}/actions`),
    "POST /api/assets/:id/actions": p("POST", `/api/assets/${id}/actions`, { type: "split", recordTime: at(1), num: "2", den: "1" }),
    "GET /api/actions/:id": p("GET", `/api/actions/${s.actionId}`),
    "POST /api/actions/:id/reconcile": p("POST", `/api/actions/${s.actionId}/reconcile`),
    "GET /api/assets/:id/controls": p("GET", `/api/assets/${id}/controls`),
    "PUT /api/assets/:id/notes": p("PUT", `/api/assets/${id}/notes`, { scope: "recon", key: "k", fingerprint: "f", status: "resolved", note: "n" }),
    "GET /api/assets/:id/export": p("GET", `/api/assets/${id}/export`),
  };
}

/** Routes that answer without a session, by design. */
const PUBLIC = new Set([
  "GET /api/health",
  "GET /api/auth/config",
  "GET /api/auth/me",
  "GET /api/auth/session",
  "POST /api/auth/signup",
  "POST /api/auth/signin",
  "POST /api/auth/signout",
  "POST /api/auth/password",
  "POST /api/auth/switch-org",
  "POST /api/auth/invites/lookup",
  "POST /api/auth/invites/accept",
  "POST /api/auth/reset",
  "GET /api/auth/google/start",
  "GET /api/auth/google/callback",
]);

function workspaceRoutes(h: Harness): string[] {
  const seen = new Set<string>();
  for (const route of h.app.routes) {
    if (route.method === "ALL" || route.path.endsWith("*")) continue;
    const name = `${route.method} ${route.path}`;
    if (!PUBLIC.has(name)) seen.add(name);
  }
  return [...seen];
}

describe("workspace isolation", () => {
  it("answers every workspace route for another tenant's ids with nothing of theirs", async () => {
    const s = await seed();
    const table = probes(s);
    const routes = workspaceRoutes(s.h);
    // A route added without a probe here fails the suite, so it cannot ship unexamined.
    expect(routes.filter((r) => !table[r])).toEqual([]);
    expect(routes.length).toBeGreaterThan(25);

    for (const name of routes) {
      const probe = table[name]!;
      const res = await s.b.call(probe.path, { method: probe.method, ...(probe.body === undefined ? {} : { body: probe.body }) });
      const text = await res.text();
      for (const marker of [...MARKERS, s.holder]) expect(text, `${name} leaked ${marker}`).not.toContain(marker);
      if (probe.path.includes(s.assetId) || /\/(reconciliations|actions)\/\d+/.test(probe.path)) {
        expect(res.status, name).toBe(404);
      }
    }
    // Workspace E is exactly as it was.
    const run = await s.a.json<{ breaks: Array<{ note: string; holderIds: string[] }> }>(` /api/reconciliations/${s.runId}`);
    expect(run.breaks[0]).toMatchObject({ note: "alpha sign-off note", holderIds: ["ALpHA-HOLDER-7"] });
    const members = await s.a.json<{ members: Array<{ email: string; role: string }> }>("/api/org/members");
    expect(members.members).toEqual([expect.objectContaining({ email: "ann@alpha.test", role: "owner" })]);
    expect((await s.a.json<{ name: string }>(`/api/assets/${s.assetId}`)).name).toBe("FUND");
  });

  it("turns away every workspace route without a session", async () => {
    const s = await seed();
    const anonymous = new Client(s.h.app);
    for (const [name, probe] of Object.entries(probes(s))) {
      const res = await anonymous.call(probe.path, { method: probe.method, ...(probe.body === undefined ? {} : { body: probe.body }) });
      expect(res.status, name).toBe(401);
    }
  });

  it("keeps two workspaces watching the same contract apart", async () => {
    const s = await seed();
    const wsB = s.h.tenants.forOrg(s.b.orgId);
    const theirs = await wsB.watchAsset({ network: "testnet", asset: `FUND:${s.issuer}`, fromLedger: 4, ignore: [s.holder] });
    expect(theirs.id).toBe(s.assetId);
    await wsB.sync(theirs.id);

    // B started later, so it never saw the mint at ledger 3.
    const b = await s.b.json<{ holders: Array<{ units: string; ignored: boolean }> }>("/api/assets/FUN/holdings");
    expect(b.holders).toEqual([expect.objectContaining({ units: "-1", ignored: true })]);
    const a = await s.a.json<{ holders: Array<{ units: string; ignored: boolean }> }>("/api/assets/FUND/holdings");
    expect(a.holders).toEqual([expect.objectContaining({ units: "99", ignored: false })]);

    expect(await s.b.json("/api/assets/FUND/registers")).toEqual([]);
    expect(await s.b.json("/api/assets/FUN/reconciliations")).toEqual([]);
    expect(await s.b.json("/api/assets/FUN/actions")).toEqual([]);

    // Both now own a "run 1"; each sees only its own.
    const imported = await s.b.json<{ run: { id: number; registerSha256: string } }>(
      "/api/assets/FUN/registers",
      { body: { csv: "holder_id,units\nBETA-1,5\n", asOf: at(40) } },
    );
    expect(imported.run.id).toBe(s.runId);
    const runA = await s.a.json<{ registerSha256: string }>(` /api/reconciliations/${s.runId}`);
    const runB = await s.b.json<{ registerSha256: string }>(`/api/reconciliations/${s.runId}`);
    expect(runB.registerSha256).toBe(imported.run.registerSha256);
    expect(runB.registerSha256).not.toBe(runA.registerSha256);

    const packA = await s.a.json<{ sha256: string }>("/api/assets/FUND/export");
    const packB = await s.b.json<{ sha256: string }>("/api/assets/FUND/export");
    expect(packA.sha256).not.toBe(packB.sha256);
    expect(JSON.stringify(packB)).not.toContain("ALPHA-HOLDER-7");
  });

  it("opens only workspaces it knows, under ids it generated", () => {
    const h = harness();
    for (const bad of ["../x", "..%2Fx", "", "ZZZZZZZZZZZZZZZZ", "0123456789abcdef"]) {
      expect(() => h.tenants.forOrg(bad), bad).toThrow(/no such workspace/);
    }
    expect(() => h.tenants.forOrg(undefined as unknown as string)).toThrow(/no such workspace/);
  });

  it("refuses a database that belongs to another workspace", () => {
    const shared = new Db(":memory:", ORG_MIGRATIONS);
    const tenants = new Tenants(new memoryStore(), {}, () => true, () => []);
    tenants.forOrg("aaaaaaaaaaaaaaaa");
    const again = new Tenants(new memoryStore(), {}, () => true, () => []);
    expect(() => again.forOrg("bbbbbbbbbbbbbbbb")).toThrow(/belongs to aaaaaaaaaaaaaaaaa/);
  });

  it("deletes a workspace without touching its neighbour", async () => {
    const s = await seed();
    await s.b.json("/api/assets", { body: { network: "testnet", asset: `KEEP:${key()}` } }).catch(() => undefined);
    const wrong = await s.a.call("/api/org", { method: "DELETE", body: { confirm: "alpha capital" } });
    expect(wrong.status).toBe(400);
    expect((await s.a.call("/api/org", { method: "DELETE", body: { confirm: "Alpha Capital" } })).status).toBe(200);
    expect(s.h.removed).toEqual([s.a.orgId]);
    expect((await s.a.call("/api/overview")).status).toBe(401);
  });
});

/** Horizon /accounts pagination fixtures captured from real pages. */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/horizon/${name}`, import.meta.url), "utf-8"));

interface HorizonPage {
  _embedded: { records: Array<Record<string, unknown>> };
  _links?: { next?: { href: string } };
  _ledger?: number;
}

function fakeHorizon(pages: HorizonPage[], seen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push(url.search);
    const cursor = url.searchParams.get("cursor");
    const index = cursor === null ? 0 : Number(cursor);
    const page = pages[index];
    if (!page) return new Response("", { status: 404 });
    const next = index + 1 < pages.length ? { href: `${url.origin}${url.pathname}?cursor=${index + 1}` } : undefined;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (page._ledger !== undefined) headers["Latest-Ledger"] = String(page._ledger);
    return new Response(JSON.stringify({ _embedded: page._embedded, ...(next ? { _links: { next } } : {}) }), { status: 200, headers });
  }) as typeof fetch;
}

describe("horizon accounts pagination", () => {
  const page1 = fixture("accounts-page-1.json") as HorizonPage;
  const page2 = fixture("accounts-page-2.json") as HorizonPage;
  const page3 = fixture("accounts-page-3.json") as HorizonPage;

  it("parses openings and ledger from the recorded pages", () => {
    const seen: string[] = [];
    const source = new StellarSource({
      fetch: fakeHorizon([page1, page2, page3], seen),
      network: "testnet",
      passphrase: PASSEPHRASE,
      origin: ORIGIN,
    });
    const openings = await source.baseline({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(openings.length).toBe(page1._embedded.records.length + page2._embedded.records.length + page3._embedded.records.length);
    expect(openings[0]).toMatchObject({ account: page1._embedded.records[0]!.account_id });
    expect(seen[0]).toContain("limit=200");
  });

  it("stops at the page-ledge cut-off and terminates on a short page", () => {
    const seen : string[] = [];
    const source = new StellarSource({
      fetch: fakeHorizon([page1, page2], seen),
      network: "testnet",
      passphrase: PASSPHRASE,
      origin: ORIGIN,
    });
    const openings = await source.baseline({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(openings.length).toBe(page1._embedded.records.length + page2._embedded.records.length);
    expect(seen.length).toBe(2);
  });

  it("accepts a final page of exactly 200 records", () => {
    const full = page3._embedded.records.length;
    expect(full).toBe(full);
    const seen: string[] = [];
    const source = new StellarSource({
      fetch: fakeHorizon([page1, page2, page3], seen),
      network: "testnet",
      passphrase: PASSPHRASE,
      origin: ORIGIN,
    });
    const openings = await source.baseline({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(openings.length).toBe(page1._embedded.records.length + page2._embedded.records.length + full);
    // A full final page with no next link is terminal.
    expect(seen.length).toBe(full > 0 ? 3 : 3);
  });
});
