import type { AssetEvent } from "./events.js";
import { sortEvents } from "./events.js";

/**
 * A holder's position taken from ledger state rather than from events, used when an asset's
 * history is older than the event source retains. Events at or before asOfLedger are already
 * reflected in it and are skipped for that holder.
 */
export interface Opening {
  amount: bigint;
  authorized?: boolean;
  asOfLedger: number;
}

export interface ReplayOptions {
  opening?: Map<string, Opening>;
  /** Ledger the baseline was started at. Applies to holders absent from `opening`. */
  baselineLedger?: number;
  /** Inclusive. */
  upToLedger?: number;
  /** Inclusive ISO-8601 time. */
  upToTime?: string;
}

export interface HoldingsState {
  balances: Map<string, bigint>;
  /** Only holders whose authorisation state is known. */
  authorized: Map<string, boolean>;
  supply: bigint;
  /** Last ledger with an applied event, or the baseline ledger. */
  ledger: number;
  eventCount: number;
  /** Holders whose balance went negative: the indexed history is incomplete for them. */
  incomplete: string[];
  /** Events skipped because required addresses were missing or malformed. */
  skipped?: AssetEvent[];
}

interface Effect {
  address: string;
  delta: bigint;
}

export function effects(ev: AssetEvent): Effect[] {
  const out: Effect[] = [];
  switch (ev.kind) {
    case "transfer":
      if (ev.from) out.push({ address: ev.from, delta: -ev.amount });
      if (ev.to) out.push({ address: ev.to, delta: ev.amount });
      break;
    case "mint":
      if (ev.to) out.push({ address: ev.to, delta: ev.amount });
      break;
    case "burn":
    case "clawback":
      if (ev.from) out.push({ address: ev.from, delta: -ev.amount });
      break;
    case "set_authorized":
      break;
  }
  return out;
}

function isMalformed(ev: AssetEvent): boolean {
  switch (ev.kind) {
    case "transfer":
      return !ev.from || !ev.to;
    case "mint":
      return !ev.to;
    case "burn":
    case "clawback":
      return !ev.from;
    case "set_authorized":
      return !ev.from || ev.authorized === undefined;
  }
}

export function replay(events: AssetEvent[], options: ReplayOptions = {}): HoldingsState {
  const { opening, baselineLedger = 0, upToLedger, upToTime } = options;
  const balances = new Map<string, bigint>();
  const authorized = new Map<string, boolean>();
  let ledger = baselineLedger;
  if (opening) {
    for (const [address, o] of opening) {
      balances.set(address, o.amount);
      if (o.authorized !== undefined) authorized.set(address, o.authorized);
    }
  }
  const cutoff = (address: string) => opening?.get(address)?.asOfLedger ?? baselineLedger;
  const negative = new Set<string>();
  const skipped: AssetEvent[] = [];
  let eventCount = 0;

  for (const ev of sortEvents(events)) {
    if (upToLedger !== undefined && ev.ledger > upToLedger) break;
    if (upToTime !== undefined && ev.closedAt > upToTime) break;
    if (isMalformed(ev)) {
      skipped.push(ev);
      continue;
    }
    let applied = false;
    if (ev.kind === "set_authorized") {
      if (ev.from && ev.authorized !== undefined && ev.ledger > cutoff(ev.from)) {
        authorized.set(ev.from, ev.authorized);
        applied = true;
      }
    } else {
      for (const { address, delta } of effects(ev)) {
        if (ev.ledger <= cutoff(address)) continue;
        const next = (balances.get(address) ?? 0n) + delta;
        balances.set(address, next);
        if (next < 0n) negative.add(address);
        applied = true;
      }
    }
    if (applied) {
      eventCount++;
      if (ev.ledger > ledger) ledger = ev.ledger;
    }
  }

  let supply = 0n;
  for (const [address, amount] of balances) {
    if (amount === 0n) balances.delete(address);
    else supply += amount;
  }
  const incomplete = [...negative].filter((a) => (balances.get(a) ?? 0n) < 0n).sort();
  const res: HoldingsState = { balances, authorized, supply, ledger, eventCount, incomplete };
  if (skipped.length > 0) res.skipped = skipped;
  return res;
}
