import { nativeToScVal } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeEvent } from "../src/chain.js";
import { Concord } from "../src/concord.js";
import { Db } from "../src/db.js";
import { Client, FakeChain, PASSPHRASE, at, harness, key, u } from "./helpers.js";

describe("decodeEvent", () => {
  const a = key();
  const b = key();
  const sym = (s: string) => nativeToScVal(s, { type: "symbol" }).toXDR("base64");
  const addr = (s: string) => nativeToScVal(s, { type: "address" }).toXDR("base64");
  const str = (s: string) => nativeToScVal(s).toXDR("base64");
  const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" }).toXDR("base64");
  const raw = (topic: string[], value: string) => ({
    id: "0000000429496729600-0000000001",
    ledger: 100,
    ledgerClosedAt: "2026-10-01T00:00:00Z",
    contractId: "CASSET",
    txHash: "ab",
    topic,
    value,
  });

  it("decodes the CAP-67 layouts", () => {
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(5n)))).toMatchObject({
      kind: "transfer",
      from: a,
      to: b,
      amount: 5n,
    });
    expect(decodeEvent(raw([sym("mint"), addr(b), str(`FUND:${a}`)], i128(7n)))).toMatchObject({ to: b, amount: 7n });
    expect(decodeEvent(raw([sym("clawback"), addr(b), str(`FUND:${a}`)], i128(7n)))).toMatchObject({ from: b });
    const auth = decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], nativeToScVal(false).toXDR("base64")));
    expect(auth).toMatchObject({ kind: "set_authorized", from: b, authorized: false, amount: 0n });
  });

  it("takes the subject from the last address when an admin leads, and reads muxed values", () => {
    expect(decodeEvent(raw([sym("mint"), addr(a), addr(b), str(`FUND:${a}`)], i128(7n)))).toMatchObject({ to: b });
    const muxed = nativeToScVal({ amount: 9n, to_muxed_id: 42n }, { type: { amount: ["symbol", "i128"], to_muxed_id: ["symbol", "u64"] } });
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b)], muxed.toXDR("base64")))).toMatchObject({ amount: 9n });
  });

  it("ignores events outside the asset set", () => {
    expect(decodeEvent(raw([sym("approve"), addr(a), addr(b)], i128(1n)))).toBeUndefined();
  });
});

describe("Concord", () => {
  let chain: FakeChain;
  let concord: Concord;
  let assetId: string;
  const issuer = key();
  const [h1, h2, h3, treasury] = [key(), key(), key(), key()];

  beforeEach(async () => {
    chain = new FakeChain();
    concord = new Concord(new Db(":memory:"), { testnet: { passphrase: PASSPHRASE, chain } });
    const asset = await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1, ignore: [treasury] });
    assetId = asset.id;
    chain.push(assetId, "set_authorized", 2, { from: h1, authorized: true });
    chain.push(assetId, "mint", 3, { to: h1, amount: u(100) });
    chain.push(assetId, "mint", 3, { to: h2, amount: u(50) });
    chain.push(assetId, "mint", 3, { to: treasury, amount: u(999) });
    chain.push(assetId, "transfer", 10, { from: h1, to: h2, amount: u(10) });
    chain.push(assetId, "set_authorized", 20, { from: h2, authorized: false });
    chain.push(assetId, "clawback", 30, { from: h2, amount: u(5) });
  });

  it("indexes in pages and is idempotent", async () => {
    for (let i = 0; i < 2500; i++) chain.push(assetId, "mint", 40, { to: h3, amount: 1n });
    expect(await concord.sync("FUND")).toEqual({ added: 2507 });
    expect(chain.calls).toBe(3);
    expect(await concord.sync("FUND")).toEqual({ added: 0 });
    const h = concord.holdings("FUND");
    expect(h.supply).toBe("1144.00025");
    expect(h.holders.find((x) => x.address === h2)).toMatchObject({ units: "55", status: "frozen" });
    expect(concord.asset("FUND").syncedLedger).toBe(100);
  });

  it("reconciles a register at its as-of time and ages breaks", async () => {
    const csv = `holder_id,account,units,status\nA,${h1},100,active\nB,${h2},50,active\n`;
    const day1 = concord.importRegister("FUND", { csv, asOf: at(5) });
    const clean = await concord.reconcile("FUND", day1.registerId);
    expect(clean.status).toBe("clean");
    expect(clean.summary).toMatchObject({ chainSupply: "150", registerTotal: "150", matchedLines: 2 });

    const day2 = concord.importRegister("FUND", { csv, asOf: at(25) });
    const run2 = await concord.reconcile("FUND", day2.registerId);
    expect(run2.breaks.map((b) => b.type).sort()).toEqual(["QUANTITY_MISMATCH", "QUANTITY_MISMATCH", "STATUS_MISMATCH"]);
    const b1 = run2.breaks.find((b) => b.address === h1)!;
    expect(b1).toMatchObject({ chainUnits: "90", registerUnits: "100", difference: "-10", firstSeen: at(25), status: "open" });

    // Signed off, the break stays signed off while the numbers hold…
    concord.setNote("FUND", "recon", b1.key, { fingerprint: b1.fingerprint, status: "acknowledged", note: "T+1 timing" }, { id: "u1", label: "ops" });
    const day3 = concord.importRegister("FUND", { csv, asOf: at(26) });
    const run3 = await concord.reconcile("FUND", day3.registerId);
    expect(run3.breaks.find((b) => b.address === h1)).toMatchObject({ status: "acknowledged", firstSeen: at(25), note: "T+1 timing", noteAuthor: "ops" });
    expect(run3.openBreaks).toBe(2);

    // …and reopens when they move.
    const day4 = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run4 = await concord.reconcile("FUND", day4.registerId);
    expect(run4.breaks.find((b) => b.address === h2 && b.type === "QUANTITY_MISMATCH")).toMatchObject({ chainUnits: "55", firstSeen: at(25) });
    chain.latest = 200;
    chain.push(assetId, "transfer", 150, { from: h1, to: h2, amount: u(1) });
    const day5 = concord.importRegister("FUND", { csv, asOf: at(160) });
    const run5 = await concord.reconcile("FUND", day5.registerId);
    expect(run5.breaks.find((b) => b.address === h1)).toMatchObject({ status: "open", noteStale: true });
  });

  it("warns when the register is ahead of the indexed chain", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(500) });
    const run = await concord.reconcile("FUND", reg.registerId);
    expect(run.chainBehind).toBe(true);
    expect(run.warnings).toHaveLength(1);
  });

  it("reconciles movements only once a journal exists, skipping ignored-only flows", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\nB,${h2},55\n`;
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\nJ3,${at(10)},transfer,${h1},${h2},10\n`,
    );
    const reg = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    expect(run.movement).toMatchObject({ events: 4, matched: 3 });
    expect(run.breaks.map((b) => b.type)).toEqual(["UNRECORDED_MOVEMENT"]);
    expect(run.breaks[0]).toMatchObject({ scope: "movement", address: h2, chainUnits: "5" });
  });

  it("starts from a baseline and only applies later events", async () => {
    const other = key();
    chain.latest = 200;
    chain.baselineResult = {
      ledger: 150,
      openings: new Map([
        [h1, { amount: u(70), authorized: true, asOfLedger: 150 }],
        [h2, { amount: u(30), asOfLedger: 152 }],
      ]),
    };
    const asset = await concord.watchAsset({ network: "testnet", asset: `OLD:${other}` });
    expect(asset).toMatchObject({ startMode: "baseline", state: "ready", baselineLedger: 150 });
    expect(asset.startLedger).toBe(151);
    chain.push(asset.id, "transfer", 151, { from: h1, to: h2, amount: u(5) });
    chain.push(asset.id, "transfer", 160, { from: h2, to: h1, amount: u(1) });
    await concord.sync("OLD");
    const h = concord.holdings("OLD");
    expect(h.holders.map((x) => [x.address, x.units])).toEqual([
      [h1, "66"],
      [h2, "29"],
    ]);
  });

  it("snapshots at the record time and reconciles a dividend paid in another asset", async () => {
    const bank = key();
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${bank}`, fromLedger: 1 });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h1, amount: u(9) });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h2, amount: u(5) });
    chain.push(cash.id, "transfer", 90, { from: treasury, to: h2, amount: u(1) });
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      windowTo: at(60),
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
    });
    expect(action.snapshot).toMatchObject({ ledger: 3, holderCount: 3 });
    expect(action.result!.summary).toMatchObject({ expectedTotal: "15", observedTotal: "14", breakCount: 1 });
    expect(action.result!.breaks[0]).toMatchObject({ type: "SHORT", address: h1, expected: "10", observed: "9" });

    const split = await concord.createAction("FUND", { type: "split", recordTime: at(35), num: "2", den: "1" });
    expect(split.result!.breaks.map((b) => b.type)).toEqual(["MISSING", "MISSING"]);
    chain.latest = 200;
    chain.push(assetId, "mint", 170, { to: h1, amount: u(90) });
    chain.push(assetId, "mint", 170, { to: h2, amount: u(55) });
    expect((await concord.reconcileAction(split.id)).state).toBe("clean");
  });

  it("holds an action as scheduled until the chain passes its record time", async () => {
    const action = await concord.createAction("FUND", { type: "redemption", recordTime: at(150), num: "1", den: "1" });
    expect(action.state).toBe("scheduled");
    chain.latest = 200;
    chain.push(assetId, "clawback", 160, { from: h1, amount: u(90) });
    const later = await concord.reconcileAction(action.id);
    expect(later.snapshot!.holderCount).toBe(3);
    expect(later.result!.breaks.map((b) => [b.type, b.address])).toEqual([["MISSING", h2]]);
  });

  it("builds the controls log and the audit pack", async () => {
    await concord.sync("FUND");
    concord.importInstructions(
      "FUND",
      `ref,type,account,units,issued_at,approved_by,reason\nI1,authorise,${h1},,${at(1)},ops,KYC\nI2,freeze,${h2},,${at(19)},compliance,order\n`,
    );
    const log = concord.controls("FUND");
    expect(log.summary).toMatchObject({ controls: 3, instructed: 2, uninstructed: 1 });
    expect(log.breaks[0]).toMatchObject({ type: "UNINSTRUCTED_CONTROL", address: h2, status: "open" });
    expect(log.records[0]).toMatchObject({ type: "clawback", units: "5", instruction: null });

    const pack = concord.auditExport("FUND");
    expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.events).toHaveLength(7);
    expect(concord.auditExport("FUND").sha256).toBe(pack.sha256);
    expect(concord.exportCsv("FUND", "controls").split("\n")[0]).toContain("instructionRef");
    expect(concord.exportCsv("FUND", "breaks")).toContain("UNINSTRUCTED_CONTROL");
  });

  it("holds the indexed-to mark still when a pass dies part-way", async () => {
    await concord.sync("FUND");
    const before = concord.asset("FUND");
    expect(before.syncedLedger).toBe(100);
    for (let i = 0; i < 1500; i++) chain.push(assetId, "mint", 150, { to: h3, amount: 1n });
    chain.latest = 200;
    chain.failOnCall = chain.calls + 2;
    await expect(concord.sync("FUND")).rejects.toThrow("connection reset");
    const stalled = concord.asset("FUND");
    // The first page is kept, but the asset does not claim to be indexed to ledger 200.
    expect(stalled).toMatchObject({ syncedLedger: 100, syncedAt: before.syncedAt });
    expect(stalled.syncError).toBe("Indexing stopped on an unexpected error.");
    expect(await concord.sync("FUND")).toEqual({ added: 500 });
    const healed = concord.asset("FUND");
    expect(healed.syncedLedger).toBe(200);
    expect(healed.syncError).toBeUndefined();
  });

  it("reports a gap instead of indexing across it", async () => {
    await concord.sync("FUND");
    chain.latest = 500_000;
    chain.oldest = 400_000;
    await expect(concord.sync("FUND")).rejects.toThrow(/longer than the network keeps events/);
    expect(concord.asset("FUND").syncError).toMatch(/Rebuild this asset/);
  });

  it("stops watching and takes every dependent row with it", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\n`;
    const reg = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    concord.importJournal("FUND", `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\n`);
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI1,freeze,${h2},,${at(19)}\n`);
    const action = await concord.createAction("FUND", { type: "split", recordTime: at(35), num: "2", den: "1" });
    concord.setNote("FUND", "recon", run.breaks[0]!.key, { fingerprint: run.breaks[0]!.fingerprint, status: "resolved", note: "x" });
    concord.setNote("FUND", `action:${action.id}`, "k", { fingerprint: "f", status: "resolved", note: "x" });
    expect(() => concord.setNote("FUND", "action:999", "k", { fingerprint: "f", status: "resolved", note: "x" })).toThrow(/scope/);

    concord.deleteRegister("FUND", reg.registerId);
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM register_positions")!.n).toBe(0);
    expect(concord.runs("FUND")).toHaveLength(0);

    await concord.unwatchAsset("FUND");
    const tables = concord.db
      .all<{ name: string }>("SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'asset_id' WHERE m.type = 'table'")
      .map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["events", "openings", "registers", "journal", "instructions", "runs", "actions", "break_notes"]));
    for (const table of tables) {
      expect(concord.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE asset_id = ?`, assetId)!.n, table).toBe(0);
    }
    expect(() => concord.asset("FUND")).toThrow(/not watched/);
    // The same asset can be watched again from scratch.
    await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
    expect(concord.holdings("FUND").holderCount).toBe(0);
  });

  it("rebuilds from fresh opening balances and keeps the books", async () => {
    await concord.sync("FUND");
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    chain.latest = 300;
    chain.baselineResult = { ledger: 250, openings: new Map([[h1, { amount: u(42), asOfLedger: 250 }]]) };
    const rebuilt = await concord.rebuild("FUND");
    expect(rebuilt).toMatchObject({ startMode: "baseline", baselineLedger: 250, startLedger: 251, state: "ready" });
    expect(concord.holdings("FUND").holders).toEqual([expect.objectContaining({ address: h1, units: "42" })]);
    expect(concord.registers("FUND").map((r) => r.id)).toEqual([reg.registerId]);
  });

  it("advances a scheduled action once the chain passes its record time", async () => {
    const action = await concord.createAction("FUND", { type: "redemption", recordTime: at(150), num: "1", den: "1" });
    expect(action.state).toBe("scheduled");
    expect(await concord.reconcileDue()).toBe(0);
    chain.latest = 200;
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(1);
    expect(concord.action(action.id).state).not.toBe("scheduled");
  });

  it("refuses a code shared by two watched assets and a pay asset from another network", async () => {
    await concord.watchAsset({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(() => concord.asset("FUND")).toThrow(/more than one/);
    expect(concord.asset(assetId).id).toBe(assetId);
  });

  it("serves the same operations over HTTP, to a signed-in user", async () => {
    const h = harness();
    h.chain.baselineResult = { ledger: 50, openings: new Map() };
    const client = await new Client(h.app).signUp("ops@example.test", "Ops");
    expect((await h.app.request("/api/overview")).status).toBe(401);

    const watched = await client.call("/api/assets", {
      body: { network: "testnet", asset: `FUND:${issuer}`, ignore: [treasury], fromLedger: 1, baseline: false },
    });
    expect(watched.status).toBe(201);
    const ws = h.tenants.forOrg(client.orgId);
    // The route ignores fromLedger and baseline: a classic asset takes opening balances.
    expect(ws.asset("FUND").startMode).toBe("baseline");
    await ws.sync("FUND");
    expect(ws.asset("FUND")).toMatchObject({ state: "ready", baselineLedger: 50 });
    await ws.unwatchAsset("FUND");
    const asset = await ws.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1, ignore: [treasury] });
    h.chain.push(asset.id, "mint", 3, { to: h1, amount: u(100) });
    h.chain.push(asset.id, "mint", 3, { to: h2, amount: u(50) });

    const created = await client.call("/api/assets/FUND/registers", {
      body: { csv: `holder_id,account,units\nA,${h1},90\nB,${h2},50\nC,${h3},oops\n`, asOf: at(40) },
    });
    expect(created.status).toBe(201);
    const { run, issues } = (await created.json()) as {
      run: { id: number; breaks: Array<{ key: string; fingerprint: string }> };
      issues: Array<{ line: number; message: string }>;
    };
    // Holder A is ten short on the register, and so the totals disagree too.
    expect(run.breaks).toHaveLength(2);
    expect(issues).toEqual([expect.objectContaining({ line: 4 })]);

    const noted = await client.call("/api/assets/FUND/notes", {
      method: "PUT",
      body: { scope: "recon", key: run.breaks[0]!.key, fingerprint: run.breaks[0]!.fingerprint, status: "resolved", note: "register corrected", author: "CEO" },
    });
    expect(noted.status).toBe(200);
    const again = await client.json<{ breaks: Array<{ noteAuthor: string }> }>(`/api/reconciliations/${run.id}`);
    expect(again.breaks[0]!.noteAuthor).toBe("Test User <ops@example.test>");
    const overview = await client.json<{ networks: string[]; assets: Array<{ code: string; openBreaks: { reconciliation: number } }> }>("/api/overview");
    expect(overview.networks).toEqual(["testnet"]);
    expect(overview.assets[0]).toMatchObject({ code: "FUND", openBreaks: { reconciliation: 1 } });

    expect((await client.call("/api/assets/NOPE/holdings")).status).toBe(404);
    expect((await client.call("/api/assets/FUND/registers", { body: { csv: "x", asOf: "y" } })).status).toBe(400);
    const csv = await client.call("/api/assets/FUND/export?section=holdings");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain(h1);
    const template = await client.call("/api/templates/register.csv");
    expect(await template.text()).toBe("holder_id,holder_name,account,units,status\n");
  });
});
