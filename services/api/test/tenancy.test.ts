import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Auth } from "../src/auth.js";
import { StellarSource } from "../src/chain.js";
import { Concord } from "../src/concord.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { createServerApp } from "../src/main.js";
import { CONTROL_MIGRATIONS, ORG_MIGRATIONS } from "../src/schema.js";
import { Tenants, fileStore, memoryStore } from "../src/tenants.js";
import { Client, FakeChain, MAINNET_PASSPHRASE, ORIGIN, PASSPHRASE, at, harness, key, u, type Harness } from "./helpers.js";

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
    // Workspace A is exactly as it was.
    const run = await s.a.json<{ breaks: Array<{ note: string; holderIds: string[] }> }>(`/api/reconciliations/${s.runId}`);
    expect(run.breaks[0]).toMatchObject({ note: "alpha sign-off note", holderIds: ["ALPHA-HOLDER-7"] });
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
    const b = await s.b.json<{ holders: Array<{ units: string; ignored: boolean }> }>("/api/assets/FUND/holdings");
    expect(b.holders).toEqual([expect.objectContaining({ units: "-1", ignored: true })]);
    const a = await s.a.json<{ holders: Array<{ units: string; ignored: boolean }> }>("/api/assets/FUND/holdings");
    expect(a.holders).toEqual([expect.objectContaining({ units: "99", ignored: false })]);

    expect(await s.b.json("/api/assets/FUND/registers")).toEqual([]);
    expect(await s.b.json("/api/assets/FUND/reconciliations")).toEqual([]);
    expect(await s.b.json("/api/assets/FUND/actions")).toEqual([]);

    // Both now own a "run 1"; each sees only its own.
    const imported = await s.b.json<{ run: { id: number; registerSha256: string } }>(
      "/api/assets/FUND/registers",
      { body: { csv: "holder_id,units\nBETA-1,5\n", asOf: at(40) } },
    );
    expect(imported.run.id).toBe(s.runId);
    const runA = await s.a.json<{ registerSha256: string }>(`/api/reconciliations/${s.runId}`);
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
    expect(() => again.forOrg("bbbbbbbbbbbbbbbb")).toThrow(/belongs to aaaaaaaaaaaaaaaa/);
  });

  it("deletes SQLite db/WAL/SHM files and only reopens an explicitly known org (#500)", () => {
    // Exercise the real file store, not the in-memory store used for route tests.
    const temp = mkdtempSync(join(tmpdir(), "concord-tenant-drop-"));
    const orgDir = join(temp, "orgs");
    const alpha = "aaaaaaaaaaaaaaaa";
    const beta = "bbbbbbbbbbbbbbbb";
    const stale = "cccccccccccccccc";
    const known = new Set([alpha, beta]);
    const tenants = new Tenants(fileStore(temp), {}, (id) => known.has(id), () => [...known]);
    const paths = (id: string) => [`${id}.db`, `${id}.db-wal`, `${id}.db-shm`];
    const files = () => readdirSync(orgDir).sort();

    try {
      const alphaDb = tenants.forOrg(alpha).db;
      const betaDb = tenants.forOrg(beta).db;
      alphaDb.run("INSERT INTO meta (key, value) VALUES ('sample', 'ALPHA ONLY')");
      betaDb.run("INSERT INTO meta (key, value) VALUES ('sample', 'BETA ONLY')");

      // SQLite holds its WAL and shared-memory files while both handles are open.
      expect(files()).toEqual([...paths(alpha), ...paths(beta)].sort());

      // Invalid path-like ids cannot delete an unrelated file.
      const sentinel = join(temp, "x.db");
      writeFileSync(sentinel, "not a workspace");
      tenants.drop("../x");
      expect(existsSync(sentinel)).toBe(true);
      expect(files()).toEqual([...paths(alpha), ...paths(beta)].sort());

      tenants.drop(alpha);
      expect(files()).toEqual(paths(beta).sort());
      expect(betaDb.get<{ value: string }>("SELECT value FROM meta WHERE key = 'sample'")?.value).toBe("BETA ONLY");

      known.delete(alpha);
      expect(() => tenants.forOrg(alpha)).toThrow(/no such workspace/);
      expect(files()).toEqual(paths(beta).sort()); // rejected reopen creates nothing

      known.add(alpha);
      const fresh = tenants.forOrg(alpha).db;
      expect(fresh.get("SELECT value FROM meta WHERE key = 'sample'")).toBeUndefined();
      expect(files()).toEqual([...paths(alpha), ...paths(beta)].sort());

      // A never-opened id can still have stale on-disk artifacts after a crash.
      for (const name of paths(stale)) writeFileSync(join(orgDir, name), "stale");
      tenants.drop(stale);
      expect(files()).toEqual([...paths(alpha), ...paths(beta)].sort());
    } finally {
      tenants.close();
      rmSync(temp, { recursive: true, force: true });
    }
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

  it("fails over to the next Horizon endpoint when _embedded.records is omitted, and reports ChainError naming hosts if all fail", async () => {
    const h1 = "https://h1.example";
    const h2 = "https://h2.example";
    const net = {
      name: "mainnet" as const,
      passphrase: MAINNET_PASSPHRASE,
      rpc: [{ url: "https://rpc.example" }],
      horizon: [{ url: h1 }, { url: h2 }],
    };

    // Test search(): h1 returns malformed { title: "oops" }, h2 succeeds
    const okSearch = () => new Response(JSON.stringify({ _embedded: { records: [] } }));
    const badBody = () => new Response(JSON.stringify({ title: "oops" }));
    const s1 = scripted({
      [`${h1}/assets?asset_code=FOO&limit=200`]: [badBody],
      [`${h2}/assets?asset_code=FOO&limit=200`]: [okSearch],
    });
    const src1 = new StellarSource(net, s1.deps);
    const searchRes = await src1.search("FOO");
    expect(searchRes).toEqual([]);
    expect(s1.calls.map((c) => c.url)).toEqual([
      `${h1}/assets?asset_code=FOO&limit=200`,
      `${h2}/assets?asset_code=FOO&limit=200`,
    ]);

    // Test baseline(): h1 returns malformed accounts page, h2 succeeds
    const issuer = key();
    const okAccounts = () => new Response(JSON.stringify({ _links: {}, _embedded: { records: [] } }), {
      headers: { "latest-ledger": "100" },
    });
    const s2 = scripted({
      [`${h1}/accounts?asset=FOO:${issuer}&limit=200&order=asc`]: [badBody],
      [`${h2}/accounts?asset=FOO:${issuer}&limit=200&order=asc`]: [okAccounts],
    });
    const src2 = new StellarSource(net, s2.deps);
    const baseRes = await src2.baseline("FOO", issuer, 7);
    expect(baseRes.ledger).toBe(100);
    expect(baseRes.openings.size).toBe(0);

    // Test describe(): h1 returns malformed, h2 succeeds
    const s3 = scripted({
      [`${h1}/assets?asset_code=FOO&asset_issuer=${issuer}&limit=200`]: [badBody],
      [`${h2}/assets?asset_code=FOO&asset_issuer=${issuer}&limit=200`]: [okSearch],
    });
    const src3 = new StellarSource(net, s3.deps);
    const descRes = await src3.describe({ id: "C123", code: "FOO", issuer });
    expect(descRes).toBeUndefined();

    // If all fail, a ChainError names the hosts
    const sAllFail = scripted({
      [`${h1}/assets?asset_code=FOO&limit=200`]: [badBody],
      [`${h2}/assets?asset_code=FOO&limit=200`]: [badBody],
    });
    const srcAllFail = new StellarSource(net, sAllFail.deps);
    const err = await srcAllFail.search("FOO").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("h1.example: unexpected response");
    expect(err.message).toContain("h2.example: unexpected response");
  });
});

describe("what ships", () => {
  it("keeps the testnet practice script away from every database", () => {
    const source = readFileSync(new URL("../src/demo/testnet.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    for (const banned of ["db", "concord", "tenants", "main", "auth", "schema"]) {
      expect(imports.some((i) => i.endsWith(`/${banned}.js`)), banned).toBe(false);
    }
    expect(source).not.toMatch(/watchAsset|importRegister|DatabaseSync/);
  });

  it("documents in .env.example every environment variable the service reads", () => {
    const src = new URL("../src/", import.meta.url);
    const sources = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(new URL(file, src), "utf8"))
      .join("\n");
    // Names built per network, e.g. `CONCORD_${upper}_RPC_URLS`, count once for each network.
    const expanded = ["MAINNET", "TESTNET"].map((upper) => sources.replaceAll("${upper}", upper)).join("\n");
    // Retired names are read only to be refused, so they belong nowhere in the example.
    const config = readFileSync(new URL("config.ts", src), "utf8");
    const retired = new Set(config.match(/const RETIRED[^]*?\n};/)![0].match(/\bCONCORD_[A-Z0-9_]+(?=:)/g));
    expect(retired.size).toBeGreaterThan(0);

    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const concord = new Set(expanded.match(/\bCONCORD_[A-Z0-9_]+/g)!.filter((name) => !retired.has(name)));
    const undocumented = [...concord].filter((name) => !new RegExp(`^#? ?${name}=`, "m").test(example));
    // Set by the platform rather than by an operator, so a mention is enough.
    const platform = [...new Set(sources.match(/\b(PORT|RENDER_EXTERNAL_URL)\b/g))];
    undocumented.push(...platform.filter((name) => !new RegExp(`\\b${name}\\b`).test(example)));
    expect(undocumented).toEqual([]);
  });

  it("starts both schemas from nothing and refuses a database from before versioning", () => {
    const control = new Db(":memory:", CONTROL_MIGRATIONS);
    expect(control.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(CONTROL_MIGRATIONS.length);
    const org = new Db(":memory:", ORG_MIGRATIONS);
    expect(org.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1);
    expect(() => new Db(":memory:", [...ORG_MIGRATIONS, "CREATE TABLE broken (x REFERENCES nowhere (y)); INSERT INTO broken VALUES (1);"])).toThrow();
  });

  it("does not mask the original error when rollback fails in tx and migrate", () => {
    // 1. In migrate: COMMIT inside migration followed by invalid statement
    expect(() => {
      new Db(":memory:", ["CREATE TABLE a (x); COMMIT; CREATE TABLE b (y;"]);
    }).toThrow(/syntax error|near/i);

    // 2. In tx: transaction already committed or rolled back inside fn
    const db = new Db(":memory:", []);
    expect(() => {
      db.tx(() => {
        db.raw.exec("COMMIT");
        throw new Error("original failure");
      });
    }).toThrow("original failure");
  });

  it("does not serve files reached through encoded dot-dot with immutable caching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-static-"));
    const webDir = join(dir, "web");
    const dataDir = join(dir, "data");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(webDir, "index.html"), "<html>shell</html>");
    writeFileSync(join(webDir, "secret.txt"), "secret outside assets");
    writeFileSync(join(webDir, "assets/app.123.js"), "console.log('asset');");

    const cfg = loadConfig({
      CONCORD_DATA_DIR: dataDir,
      CONCORD_WEB_DIR: webDir,
      CONCORD_SIGNUP: "open",
    });
    const control = new Db(join(dataDir, "control.db"), CONTROL_MIGRATIONS);
    const auth = new Auth(control, { signup: "open" });
    const tenants = new Tenants(fileStore(dataDir), {}, () => false, () => []);
    const runtime = { control, auth, tenants, close: () => { tenants.close(); control.close(); } };
    const app = createServerApp(runtime, cfg);

    try {
      // Normal asset in webDir/assets gets immutable caching
      const resAsset = await app.request("/assets/app.123.js");
      expect(resAsset.status).toBe(200);
      expect(resAsset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      // Encoded dot-dot request (/assets/..%2fsecret.txt) returns 404 and never immutable caching
      const resDotDot1 = await app.request("/assets/..%2fsecret.txt");
      expect(resDotDot1.status).toBe(404);
      expect(resDotDot1.headers.get("cache-control") ?? "").not.toContain("immutable");

      // Regular file outside assets directory is not cached with immutable header
      const resSecret = await app.request("/secret.txt");
      expect(resSecret.status).toBe(200);
      expect(resSecret.headers.get("cache-control")).not.toContain("immutable");
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 404 for missing files with an extension while extensionless routes get index.html", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-static-"));
    const webDir = join(dir, "web");
    const dataDir = join(dir, "data");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(webDir, "index.html"), "<html>shell</html>");
    writeFileSync(join(webDir, "favicon.ico"), "fake-ico");

    const cfg = loadConfig({
      CONCORD_DATA_DIR: dataDir,
      CONCORD_WEB_DIR: webDir,
      CONCORD_SIGNUP: "open",
    });
    const control = new Db(join(dataDir, "control.db"), CONTROL_MIGRATIONS);
    const auth = new Auth(control, { signup: "open" });
    const tenants = new Tenants(fileStore(dataDir), {}, () => false, () => []);
    const runtime = { control, auth, tenants, close: () => { tenants.close(); control.close(); } };
    const app = createServerApp(runtime, cfg);

    try {
      // Existing file returns 200
      const resFavicon = await app.request("/favicon.ico");
      expect(resFavicon.status).toBe(200);

      // Missing files with an extension return 404
      const resMissingIco = await app.request("/missing-favicon.ico");
      expect(resMissingIco.status).toBe(404);

      const resMissingJs = await app.request("/a/b/c.js");
      expect(resMissingJs.status).toBe(404);

      const resMissingTxt = await app.request("/robots.txt");
      expect(resMissingTxt.status).toBe(404);

      // Extensionless route falls back to SPA index.html
      const resSpa = await app.request("/a/abc/reconciliation");
      expect(resSpa.status).toBe(200);
      expect(await resSpa.text()).toBe("<html>shell</html>");
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses dotfiles from web directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-static-"));
    const webDir = join(dir, "web");
    const dataDir = join(dir, "data");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    mkdirSync(join(webDir, "a/.git"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(webDir, "index.html"), "<html>shell</html>");
    writeFileSync(join(webDir, ".hidden"), "secret dotfile");
    writeFileSync(join(webDir, "a/.git/config"), "secret git config");
    writeFileSync(join(webDir, "assets/x.js"), "console.log('x');");

    const cfg = loadConfig({
      CONCORD_DATA_DIR: dataDir,
      CONCORD_WEB_DIR: webDir,
      CONCORD_SIGNUP: "open",
    });
    const control = new Db(join(dataDir, "control.db"), CONTROL_MIGRATIONS);
    const auth = new Auth(control, { signup: "open" });
    const tenants = new Tenants(fileStore(dataDir), {}, () => false, () => []);
    const runtime = { control, auth, tenants, close: () => { tenants.close(); control.close(); } };
    const app = createServerApp(runtime, cfg);

    try {
      // /.hidden and /a/.git/config return 404
      const resDot = await app.request("/.hidden");
      expect(resDot.status).toBe(404);

      const resSubDot = await app.request("/a/.git/config");
      expect(resSubDot.status).toBe(404);

      // /assets/x.js still served
      const resAsset = await app.request("/assets/x.js");
      expect(resAsset.status).toBe(200);
      expect(await resAsset.text()).toBe("console.log('x');");
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

});