/** The CAP-67 unified event set for an asset, classic or SEP-41. */
export const EVENT_KINDS = ["transfer", "mint", "burn", "clawback", "set_authorized"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface AssetEvent {
  /** RPC event id. Zero-padded, so string order is ledger order. */
  id: string;
  assetId: string;
  kind: EventKind;
  ledger: number;
  /** ISO-8601 close time of the ledger. */
  closedAt: string;
  txHash: string;
  from?: string;
  to?: string;
  /** Smallest unit. Zero for set_authorized. */
  amount: bigint;
  /** set_authorized only. */
  authorized?: boolean;
}

export function isEventKind(value: string): value is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(value);
}

export function sortEvents<T extends { id: string }>(events: T[]): T[] {
  return [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The holder a control or supply event acts on. */
export function subject(ev: AssetEvent): string | undefined {
  return ev.kind === "mint" ? ev.to : ev.from;
}
