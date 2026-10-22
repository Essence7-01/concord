import { ArrowSquareOut, Check, Copy, DownloadSimple, WarningCircle } from "@phosphor-icons/react";
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { download, type Issue, type Network } from "./api";

/** The network of whatever is on screen, so explorer links point at the right ledger. */
export const NetworkContext = createContext<Network>("mainnet");

const explorer = (network: Network) =>
  `https://stellar.expert/explorer/${network === "mainnet" ? "public" : "testnet"}`;

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load()
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller controls invalidation via deps array and reload tick
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Runs an action with busy and error state for a form or a button. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

type Variant = "primary" | "quiet" | "danger";
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean };

const LOOKS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink border-accent hover:opacity-90",
  quiet: "bg-surface text-text border-line-strong hover:bg-sunken",
  danger: "bg-surface text-bad border-bad hover:bg-bad-bg",
};
const BUTTON =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded border px-3 text-[13px] font-medium transition-[transform,background-color,opacity] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50";

export function Button({
  variant = "quiet",
  busy,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${BUTTON} ${LOOKS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/** A link that reads as a button, for navigations that leave the page. */
export function LinkButton({
  variant = "quiet",
  className = "",
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant }) {
  return (
    <a {...rest} className={`${BUTTON} ${LOOKS[variant]} ${className}`}>
      {children}
    </a>
  );
}

/** Two or three exclusive choices, set side by side. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded border border-line-strong bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`h-6 rounded-[3px] px-2.5 text-xs font-medium transition-colors duration-150 ${o.value === value ? "bg-surface text-text shadow-[0_0_0_1px_var(--line-strong)]" : "text-muted hover:text-text"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs text-bad">{error}</span>}
    </label>
  );
}

export const inputClass =
  "h-8 w-full rounded border border-line-strong bg-surface px-2.5 text-[13px] text-text placeholder:text-muted file:mr-3 file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-text";

const TONES = {
  ok: "bg-ok-bg text-ok",
  bad: "bg-bad-bg text-bad",
  warn: "bg-warn-bg text-warn",
  neutral: "bg-sunken text-muted",
} as const;

export function Badge({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-5 items-center whitespace-nowrap rounded px-1.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [keyof typeof TONES, string]> = {
    clean: ["ok", "Clean"],
    ok: ["ok", "Matched"],
    breaks: ["bad", "Breaks"],
    open: ["bad", "Open"],
    acknowledged: ["warn", "Acknowledged"],
    resolved: ["ok", "Resolved"],
    scheduled: ["neutral", "Scheduled"],
    pending: ["neutral", "Pending"],
    active: ["neutral", "Active"],
    frozen: ["warn", "Frozen"],
    MISSING: ["bad", "Missing"],
    SHORT: ["bad", "Short"],
    EXCESS: ["bad", "Excess"],
    UNEXPECTED: ["warn", "Unexpected"],
  };
  const [tone, label] = map[status] ?? ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 5)}…${value.slice(-5)}` : value;
}

export function Addr({ value }: { value: string | null | undefined }) {
  const network = useContext(NetworkContext);
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-muted">none</span>;
  const kind = value.startsWith("C") ? "contract" : "account";
  return (
    <span className="group inline-flex items-center gap-1">
      <button
        type="button"
        title={`${value} (click to copy)`}
        onClick={() => {
          // The clipboard is only there on a secure page; without it the full value is still in the tooltip.
          void navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
            .catch(() => undefined);
        }}
        className="num inline-flex items-center gap-1 rounded hover:text-accent"
      >
        {short(value)}
        {copied ? (
          <Check size={12} />
        ) : (
          <Copy size={12} className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
        )}
      </button>
      {/^[GC][A-Z2-7]{55}$/.test(value) && (
        <a
          href={`${explorer(network)}/${kind}/${value}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${kind} on Stellar Expert`}
          title="Open on Stellar Expert"
          className="rounded text-muted opacity-0 hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
        >
          <ArrowSquareOut size={12} />
        </a>
      )}
    </span>
  );
}

export function Tx({ hash }: { hash: string | null | undefined }) {
  const network = useContext(NetworkContext);
  if (!hash) return null;
  return (
    <a
      href={`${explorer(network)}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="num inline-flex items-center gap-1 hover:text-accent"
      title={hash}
    >
      {hash.slice(0, 8)}
      <ArrowSquareOut size={12} />
    </a>
  );
}

export function Units({ value, signed }: { value: string | null | undefined; signed?: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted">n/a</span>;
  const negative = value.startsWith("-");
  const [whole = "0", frac] = value.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative ? "-" : signed && value !== "0" ? "+" : "";
  const tone = signed && value !== "0" ? "text-bad" : "";
  return (
    <span className={`num ${tone}`}>
      {sign}
      {grouped}
      {frac && <span className="opacity-60">.{frac}</span>}
    </span>
  );
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** A datetime-local value, which the browser reads in the viewer's own zone, as an ISO instant. */
export function localToIso(value: string): string {
  return new Date(value).toISOString();
}

/** Shown under date pickers: tables are in UTC, pickers are not. */
export const LOCAL_TIME_HINT = `Your local time (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Tables show UTC.`;

export function ErrorNote({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded bg-bad-bg px-3 py-2 text-[13px] text-bad">
      <WarningCircle size={16} className="mt-0.5 shrink-0" />
      {message}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded bg-warn-bg px-3 py-2 text-[13px] text-warn">{children}</div>;
}

/** Rows a CSV import turned away, with the line each came from. */
export function IssueList({ issues, what }: { issues: Issue[]; what: string }) {
  if (issues.length === 0) return null;
  return (
    <details className="rounded bg-warn-bg px-3 py-2 text-[13px] text-warn" open={issues.length <= 5}>
      <summary className="cursor-pointer font-medium">
        {issues.length} {issues.length === 1 ? "row" : "rows"} of the {what} not loaded
      </summary>
      <ul className="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto">
        {issues.map((issue) => (
          <li key={`${issue.line}-${issue.message}`} className="flex gap-3">
            <span className="num shrink-0">line {issue.line}</span>
            <span>{issue.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Downloads a CSV holding only the header row an import expects. */
export function TemplateLink({ kind }: { kind: "register" | "journal" | "instructions" }) {
  const { error, run } = useAction();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void run(() => download(`/templates/${kind}.csv`, `concord-${kind}-template.csv`))}
        className="inline-flex items-center gap-1 rounded text-xs font-medium text-accent hover:underline"
      >
        <DownloadSimple size={12} />
        Blank template
      </button>
      {error && <span className="text-xs text-bad">{error}</span>}
    </span>
  );
}

/** Keeps one broken screen from blanking the whole dashboard. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { message?: string }> {
  override state: { message?: string } = {};

  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }

  override render() {
    if (this.state.message === undefined) return this.props.children;
    return (
      <div className="flex flex-col items-start gap-3">
        <ErrorNote message={`This screen stopped working: ${this.state.message}`} />
        <Button onClick={() => location.reload()}>Reload</Button>
      </div>
    );
  }
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-line-strong px-6 py-10">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-[60ch] text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-8" />
      ))}
    </div>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Figures set in a row with hairlines between them, not boxed cards. */
export function Figures({ items }: { items: Array<{ label: string; value: ReactNode; tone?: "bad" | "ok" }> }) {
  return (
    <dl className="grid grid-cols-2 gap-y-4 border-y border-line py-4 md:grid-flow-col md:auto-cols-fr md:grid-cols-none md:divide-x md:divide-line">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-1 md:px-4 md:first:pl-0">
          <dt className="text-xs text-muted">{item.label}</dt>
          <dd
            className={`text-lg font-semibold ${item.tone === "bad" ? "text-bad" : item.tone === "ok" ? "text-ok" : ""}`}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto rounded border border-line bg-surface">{children}</div>;
}

export async function readFile(file: File | undefined | null): Promise<string> {
  if (!file) throw new Error("Choose a CSV file first");
  return file.text();
}
