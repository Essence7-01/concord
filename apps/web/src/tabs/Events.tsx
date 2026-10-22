import { ArrowsClockwise } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { api, type AssetSummary, type ChainEvent } from "../api";
import { Addr, Button, Empty, ErrorNote, Field, Skeleton, TableWrap, Tx, Units, inputClass, when } from "../ui";

const KINDS: Array<[string, string]> = [
  ["", "All events"],
  ["transfer", "Transfer"],
  ["mint", "Mint"],
  ["burn", "Burn"],
  ["clawback", "Clawback"],
  ["set_authorized", "Authorisation"],
];
const PAGE = 100;

function describe(e: ChainEvent): string {
  if (e.kind !== "set_authorized") return KINDS.find(([k]) => k === e.kind)?.[1] ?? e.kind;
  return e.authorized ? "Authorised" : "Frozen";
}

export function Events({ asset }: { asset: AssetSummary }) {
  const [kind, setKind] = useState("");
  const [typed, setTyped] = useState("");
  const [address, setAddress] = useState("");
  const [rows, setRows] = useState<ChainEvent[]>();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Ledger the list was last read at, to offer a refresh when the index has moved on. */
  const [readAt, setReadAt] = useState(asset.syncedLedger);
  // Only the latest request may write to the list; a slow earlier one would otherwise overwrite it.
  const latest = useRef(0);

  // Wait for typing to pause before asking the server.
  useEffect(() => {
    const id = setTimeout(() => setAddress(typed.trim()), 300);
    return () => clearTimeout(id);
  }, [typed]);

  const load = async (before?: string) => {
    const request = ++latest.current;
    setBusy(true);
    try {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (kind) q.set("kind", kind);
      if (address) q.set("address", address);
      if (before) q.set("before", before);
      const page = await api<ChainEvent[]>(`/assets/${asset.id}/events?${q}`);
      if (request !== latest.current) return;
      setRows((prev) => (before && prev ? [...prev, ...page] : page));
      setMore(page.length === PAGE);
      setError(undefined);
      if (!before) setReadAt(asset.syncedLedger);
    } catch (e) {
      if (request === latest.current) setError((e as Error).message);
    } finally {
      if (request === latest.current) setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is recreated on each render; query inputs (asset.id, kind, address) trigger fetch
  }, [asset.id, kind, address]);

  const stale = rows !== undefined && asset.syncedLedger !== readAt;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px]">
          <Field label="Event">
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
              {KINDS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="min-w-[260px] flex-1 md:max-w-xl">
          <Field label="Address">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className={`${inputClass} num`}
              spellCheck={false}
            />
          </Field>
        </div>
        <Button busy={busy} onClick={() => void load()}>
          <ArrowsClockwise size={16} />
          {stale ? "Show newer events" : "Refresh"}
        </Button>
      </div>
      {error && <ErrorNote message={error} />}
      {!rows && !error && <Skeleton rows={8} />}
      {rows?.length === 0 && (
        <Empty title={kind || address ? "No events match" : "No events indexed yet"}>
          {asset.state === "indexing"
            ? "Events appear here once the asset's history has been read."
            : `Concord indexes transfer, mint, burn, clawback and authorisation events from ledger ${asset.startLedger ?? "the start of its history"}.`}
        </Empty>
      )}
      {rows && rows.length > 0 && (
        <TableWrap>
          <table className="tbl">
            <thead>
              <tr>
                <th>Closed</th>
                <th className="r">Ledger</th>
                <th>Event</th>
                <th>From</th>
                <th>To</th>
                <th className="r">Units</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap text-[13px]">{when(e.closedAt)}</td>
                  <td className="r num">{e.ledger}</td>
                  <td className="text-[13px]">{describe(e)}</td>
                  <td>{e.from && <Addr value={e.from} />}</td>
                  <td>{e.to && <Addr value={e.to} />}</td>
                  <td className="r">{e.units !== null && <Units value={e.units} />}</td>
                  <td>
                    <Tx hash={e.txHash} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {more && rows && (
        <div>
          <Button busy={busy} onClick={() => void load(rows.at(-1)?.id)}>
            Load older
          </Button>
        </div>
      )}
    </div>
  );
}
