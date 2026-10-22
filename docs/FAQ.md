# Frequently Asked Questions (FAQ)

Short answers to common questions about Concord's architecture, data storage, network operations, and operational limits.

---

### Is Concord read-only? Does it touch private keys or move money?

Yes. Concord is strictly read-only:

- **No custody or signing:** Concord never creates, holds, or accesses private keys, and it provides no endpoints or workflows to sign or submit transactions to the Stellar network ([`services/api/src/chain.ts`](../services/api/src/chain.ts), [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md#L4-L6)).
- **Query-only network activity:** Ledger interaction is confined to querying Stellar RPC (`getEvents`, `getHealth`, `getLedgerEntries`) and Horizon endpoints (`/accounts`, `/assets`) ([`services/api/src/chain.ts`](../services/api/src/chain.ts#L307-L329)).
- **Reconciliation only:** It compares on-chain events against off-chain books (register, journal, and instruction CSVs) uploaded by workspace users. It never moves funds or executes corporate actions on-chain ([`BRIEF.md`](../BRIEF.md#L29), [`README.md`](../README.md#L197)).

---

### Why does Concord not send email?

Concord deliberately avoids sending emails for sign-ups, invitations, or password resets ([`README.md`](../README.md#L42-L46), [`README.md`](../README.md#L146-L147)):

- **Zero external dependencies:** Concord requires no external SMTP server, mail relay (e.g. SendGrid, Amazon SES), or DNS configuration (SPF, DKIM, DMARC) to deploy and run.
- **Operator-controlled distribution:** Workspace owners generate invitation links directly through the dashboard and distribute them over their organisation's secure communications channels. Password resets are generated on-demand by administrators via the CLI (`pnpm concord reset-link EMAIL`; see [`services/api/src/cli.ts`](../services/api/src/cli.ts#L86-L94) and [`services/api/src/auth.ts`](../services/api/src/auth.ts)).
- **Security in regulated environments:** Transfer agents, custodians, and fund administrators often operate inside restricted networks where outbound email is restricted or where sending credential-bearing tokens through external mail servers presents compliance and data-leakage risks.

---

### Why does Concord use SQLite?

Concord uses Node's native `node:sqlite` in WAL (Write-Ahead Logging) mode ([`services/api/src/db.ts`](../services/api/src/db.ts#L3), [`services/api/src/schema.ts`](../services/api/src/schema.ts)):

- **Zero database administration:** Running Concord requires only Node 24+ and a local disk. There is no separate database server daemon (such as PostgreSQL or MySQL) to provision, monitor, tune, or migrate.
- **Physical tenant isolation:** Control data (users, accounts, workspace memberships, sessions) is stored in `data/control.db`. Each workspace is stored in its own dedicated database file (`data/orgs/<workspace_id>.db`; see [`services/api/src/tenants.ts`](../services/api/src/tenants.ts)). Data belonging to one organisation cannot be queried or reached from another workspace database.
- **Single-process architecture:** Concord runs as a single process combining the background indexer, API server, and dashboard. Holdings are replayed in-memory from indexed ledger events and opening balances, making SQLite queries fast and lightweight.
- **Straightforward backups:** A workspace or entire installation can be backed up online using SQLite's native backup API without stopping the server (`pnpm concord backup <destination>`; see [`services/api/src/cli.ts`](../services/api/src/cli.ts#L4,L228-L242)).

---

### What assets are supported?

Concord supports regulated tokens on Stellar using CAP-67 event indexing ([`packages/core/src/events.ts`](../packages/core/src/events.ts), [`services/api/src/chain.ts`](../services/api/src/chain.ts#L80-L89)):

- **Classic Stellar assets:** Identified by `CODE:ISSUER` (Alphanumeric 4 or 12 code and an Ed25519 issuer public key). Classic assets have fixed 7-decimal precision. Concord establishes a baseline by fetching opening trustline balances from Horizon (`chain.ts#L376-L401`) and indexes subsequent CAP-67 events from that ledger forward. Note that Horizon trustline queries do not capture balances locked in liquidity pools, claimable balances, or smart contracts ([`README.md`](../README.md#L132-L136)).
- **Contract tokens (SEP-41):** Identified by a Soroban contract address (`C...`). Decimals are read from the contract instance storage (`describeInstance` in `chain.ts#L465-L512`) or provided when watching the asset. Contract tokens that do not wrap a classic asset have no Horizon opening balances; their holdings count movements from the oldest ledger retained by RPC history ([`README.md`](../README.md#L137-L140)).
- **Tracked event types:** Concord indexes standard CAP-67 operations: `transfer`, `mint`, `burn`, `clawback`, and `set_authorized` ([`packages/core/src/events.ts`](../packages/core/src/events.ts#L6-L10), [`services/api/src/chain.ts`](../services/api/src/chain.ts#L108-L149)).

---

### How does mainnet versus testnet operation work?

Concord natively serves both Stellar Mainnet and Testnet ([`services/api/src/config.ts`](../services/api/src/config.ts), [`README.md`](../README.md#L27-L35)):

- **Dashboard switching:** Users can switch between networks at any time using the network toggle at the top left of the dashboard.
- **Concurrent indexing:** A workspace can watch assets on both Mainnet and Testnet concurrently. The indexer synchronises networks side-by-side so delays or issues on one network do not stall the other ([`services/api/src/concord.ts`](../services/api/src/concord.ts#L498-L516)).
- **RPC configuration:** By default, Concord connects to public Stellar RPC and Horizon endpoints. Production deployments can configure dedicated private RPC endpoints using `CONCORD_MAINNET_RPC_URLS` and `CONCORD_TESTNET_RPC_URLS` ([`.env.example`](../.env.example)).
- **Practice testnet asset:** Concord provides a CLI simulation script (`pnpm demo:testnet`; see [`services/api/src/demo/testnet.ts`](../services/api/src/demo/testnet.ts)) that issues a test regulated asset on Testnet, runs transactions (subscriptions, transfers, dividends, splits, freezes, clawbacks), and outputs mock register, journal, and instruction CSV files for practice and validation without touching real assets.

---

### Where is Concord's data stored?

All data is stored on local disk under the path specified by the `CONCORD_DATA_DIR` environment variable (defaults to `./data` in development or `/data` when running in Docker; see [`Dockerfile`](../Dockerfile#L48)):

- `data/control.db`: Stores global system state, including user accounts, password hashes (scrypt), workspace records, team memberships, active sessions, invitation tokens, and signup codes ([`services/api/src/schema.ts`](../services/api/src/schema.ts#L18-L68)).
- `data/orgs/<workspace_id>.db`: One SQLite database per workspace. Contains watched asset definitions, indexed ledger events, baseline opening balances, uploaded register, journal, and instruction CSV files, reconciliation runs, corporate actions, and sign-off notes ([`services/api/src/schema.ts`](../services/api/src/schema.ts#L70-L162), [`services/api/src/tenants.ts`](../services/api/src/tenants.ts)).
- `data/demo/`: Directory where practice testnet CSV files generated by `pnpm demo:testnet` are written.

---

### How does sign-off reopening work?

When an operator acknowledges or resolves a reconciliation break, Concord records their note alongside a cryptographic snapshot of the break's figures ([`services/api/src/concord.ts`](../services/api/src/concord.ts#L1049-L1102)):

- **Fingerprints:** Each sign-off captures the break's stable key and a `fingerprint` reflecting the exact figures at that moment (e.g. `${chainUnits}|${registerUnits}` for position breaks, or `${expected}|${observed}` for corporate action breaks; see [`services/api/src/concord.ts`](../services/api/src/concord.ts#L905,L1262)).
- **Automatic reopening:** When a new register is uploaded or new on-chain events are indexed, Concord re-evaluates breaks. If the figures change, the new fingerprint differs from the stored fingerprint. Concord automatically reopens the break (setting its status back to `open`) and marks the existing note as stale (`noteStale: true`; see [`services/api/src/concord.ts`](../services/api/src/concord.ts#L1053-L1070)).
- This guarantees that an existing sign-off note cannot silently conceal a newly widened or altered balance discrepancy.

---

### What happens if the indexer is offline for more than 7 days?

Stellar RPC nodes retain ledger event history for approximately seven days ([`README.md`](../README.md#L132,L141-L143)):

- **Gap detection:** When Concord resumes indexing after downtime, it compares its saved cursor ledger against the oldest ledger still retained by the RPC node (`at + 1 < head.oldest` in [`services/api/src/concord.ts`](../services/api/src/concord.ts#L523-L529)). If the cursor is older than the RPC retention window, intermediate events are missing.
- **Indexing stops:** Concord immediately halts indexing for that asset and sets a `sync_error` explaining that events were lost. This prevents the system from computing corrupted or incomplete holdings.
- **Recovery via Rebuild:** To recover, the operator selects **Rebuild history** in the asset's settings on the dashboard, or runs `pnpm concord rebuild <asset>` via the CLI ([`services/api/src/cli.ts`](../services/api/src/cli.ts#L160-L163)). Rebuilding resets the event cursor and fetches a fresh baseline of opening balances from Horizon, while safely preserving all uploaded registers, journals, instructions, past reconciliation runs, and sign-off notes ([`services/api/src/concord.ts`](../services/api/src/concord.ts#L457-L480)).

---

### How is Concord licensed?

Concord is open-source software distributed under the **MIT License** ([`LICENSE`](../LICENSE), [`README.md`](../README.md#L211-L213)):

- Permission is granted free of charge to any person obtaining a copy of the software to deal in the Software without restriction, including the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies.
- The software is provided "as is", without warranty of any kind.
