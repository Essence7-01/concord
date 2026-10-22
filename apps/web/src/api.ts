export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The workspace this tab is showing. Sent with every call so a stale tab cannot act on another. */
let shownOrg: string | undefined;

export function showOrg(orgId: string | undefined): void {
  shownOrg = orgId;
}

/** Raised when the server no longer recognises the session, wherever the call came from. */
export const UNAUTHORIZED = "concord:unauthorized";

function headers(json: boolean): HeadersInit {
  const h: Record<string, string> = {};
  if (json) h["content-type"] = "application/json";
  if (shownOrg) h["x-concord-org"] = shownOrg;
  return h;
}

async function failure(res: Response, fallback: string): Promise<ApiError> {
  const detail = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED));
  return new ApiError(detail?.error ?? `${fallback} (${res.status})`, res.status);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: headers(init.body !== undefined),
      credentials: "same-origin",
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError("The Concord server is not reachable. Check your connection and try again.", 0);
  }
  if (!res.ok) throw await failure(res, "Request failed");
  return (await res.json()) as T;
}

/** Downloads go through fetch so a failure can be shown in place instead of on a blank page. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api${path}`, { headers: headers(false), credentials: "same-origin" });
  if (!res.ok) throw await failure(res, "Download failed");
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export type Network = "mainnet" | "testnet";

export interface AuthConfig {
  signup: "open" | "code";
  google: boolean;
  /** The host erases everything on restart. */
  ephemeral: boolean;
  networks: Network[];
  defaultNetwork: Network;
}

export type Role = "owner" | "member";

export interface Me {
  user: { id: string; email: string; name: string; hasPassword: boolean; hasGoogle: boolean };
  org: { id: string; name: string };
  role: Role;
  orgs: Array<{ id: string; name: string; role: Role }>;
}

export interface Team {
  members: Array<{ id: string; email: string; name: string; role: Role; joinedAt: string }>;
  invites: Array<{ id: string; email: string; role: Role; createdAt: string; expiresAt: string }>;
}

export interface Candidate {
  asset: string;
  code: string;
  issuer: string;
  contractId: string;
  trustlines: number;
  authorizedUnits: string;
  authRequired: boolean;
  authRevocable: boolean;
  clawbackEnabled: boolean;
}

export interface Issue {
  line: number;
  message: string;
}

export interface RegisterFile {
  id: number;
  asOf: string;
  source: string;
  sha256: string;
  positions: number;
  issues: Issue[];
  importedBy: string | null;
  importedAt: string;
}

export interface AssetSummary {
  id: string;
  network: Network;
  code: string;
  issuer?: string;
  name: string;
  decimals: number;
  /** "indexing" until opening balances and the starting point are in. */
  state: "indexing" | "ready";
  /** "window": no opening balances, history starts at the oldest ledger the RPC keeps. */
  startMode: "baseline" | "ledger" | "window";
  startLedger?: number;
  baselineLedger?: number;
  historyFrom?: string;
  syncedLedger?: number;
  syncedAt?: string;
  syncError?: string;
  syncErrorAt?: string;
  ignore: string[];
  supply: string;
  holderCount: number;
  eventCount: number;
  incomplete: boolean;
  lastRun: { id: number; asOf: string; status: string; openBreaks: number } | null;
  openBreaks: { reconciliation: number; controls: number; actions: number };
}

export interface Overview {
  networks: Network[];
  assets: AssetSummary[];
}

export interface Break {
  scope: string;
  type: string;
  severity: "high" | "medium" | "low";
  key: string;
  fingerprint: string;
  message: string;
  firstSeen?: string;
  address?: string | null;
  holderIds?: string[];
  ref?: string | null;
  txHash?: string | null;
  chainUnits?: string | null;
  registerUnits?: string | null;
  expected?: string;
  observed?: string;
  difference?: string | null;
  noteScope: string;
  status: "open" | "acknowledged" | "resolved";
  note: string | null;
  noteAuthor: string | null;
  noteAt: string | null;
  noteStale: boolean;
}

export interface RunLine {
  address: string;
  holderIds: string[];
  chainUnits: string;
  registerUnits: string;
  difference: string;
  chainStatus: string | null;
  registerStatus: string | null;
  matched: boolean;
}

export interface Run {
  id: number;
  asOf: string;
  createdAt: string;
  registerId: number;
  registerSha256: string;
  chainLedger: number;
  chainBehind: boolean;
  warnings: string[];
  status: "clean" | "breaks";
  summary: {
    chainSupply: string;
    registerTotal: string;
    supplyDifference: string;
    unmappedUnits: string;
    grossDifference: string;
    chainHolders: number;
    registerHolders: number;
    lines: number;
    matchedLines: number;
    breakCount: number;
  };
  lines: RunLine[];
  movement: { from: string | null; to: string; events: number; entries: number; matched: number } | null;
  breaks: Break[];
  openBreaks: number;
}

export interface RunSummary {
  id: number;
  asOf: string;
  createdAt: string;
  status: string;
  openBreaks: number;
}

export interface Holdings {
  asOf: string | null;
  ledger: number;
  supply: string;
  holderCount: number;
  incomplete: string[];
  holders: Array<{ address: string; units: string; share: number; status: string | null; ignored: boolean }>;
}

export interface ChainEvent {
  id: string;
  kind: string;
  ledger: number;
  closedAt: string;
  txHash: string;
  from: string | null;
  to: string | null;
  units: string | null;
  authorized: boolean | null;
}

export interface Action {
  id: number;
  type: "dividend" | "split" | "redemption";
  label: string;
  recordTime: string;
  params: Record<string, unknown>;
  state: "scheduled" | "pending" | "clean" | "breaks";
  reconciledAt: string | null;
  snapshot: { ledger: number; takenAt: string; holderCount: number } | null;
  result: {
    reconciledThrough: string | null;
    warnings: string[];
    flowAsset: { id: string; code: string };
    summary: { holders: number; expectedTotal: string; observedTotal: string; difference: string; breakCount: number };
    lines: Array<{
      address: string;
      basis: string;
      expected: string;
      observed: string;
      difference: string;
      txHashes: string[];
      status: string;
    }>;
    breaks: Break[];
  } | null;
  openBreaks: number;
}

export interface Instruction {
  ref: string;
  type: string;
  account: string;
  units: string | null;
  issuedAt: string;
  approvedBy: string | null;
  reason: string | null;
}

export interface Controls {
  asOf: string | null;
  summary: { controls: number; instructed: number; uninstructed: number; unexecuted: number; pending: number };
  records: Array<{
    eventId: string;
    type: string;
    account: string;
    units: string | null;
    ledger: number;
    closedAt: string;
    txHash: string;
    instruction: Instruction | null;
  }>;
  pending: Instruction[];
  breaks: Break[];
  openBreaks: number;
}
