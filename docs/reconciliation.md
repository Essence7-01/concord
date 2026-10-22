# How Reconciliation Works

Concord proves that tokenized securities on Stellar match the official share register kept off-chain by transfer agents, custodians, and fund administrators.

This document describes the mechanics of Concord's position and movement reconciliation engines, including event replay, omnibus handling, tolerance, ignore lists, and a worked numeric example producing every break type.

---

## 1. Architecture & Engine Pipeline

Reconciliation in Concord operates in two distinct modes:
1. **Position Reconciliation** (`packages/core/src/reconcile.ts`): Verifies end-of-period point-in-time balances and authorization status between the ledger and the official register snapshot.
2. **Movement Reconciliation** (`packages/core/src/movements.ts`): Reconciles transactional flow between on-chain ledger events and the transfer agent's operational journal.

---

## 2. Position Reconciliation Mechanics

### Event Replay to As-Of Time
Rather than querying current ledger state, Concord reconstructs the exact historical holdings state at the register's snapshot cutoff (`register.asOf` timestamp):
- `replay(events, { upToTime: register.asOf, opening, baselineLedger })` in `packages/core/src/holdings.ts`.
- Events (`mint`, `transfer`, `burn`, `clawback`, `set_authorized`) are sorted chronologically by ledger sequence and application order (`sortEvents` in `packages/core/src/events.ts`).
- Any events closed after `register.asOf` (`ev.closedAt > upToTime`) are excluded from state computation.
- If an opening baseline exists (`Opening` with `asOfLedger`), events occurring at or before the baseline ledger are skipped for that address.

### Address Aggregation & Omnibus Accounts
- Register files list positions by `holder_id`, `units`, optional `status`, and optional on-chain `account` (`packages/core/src/register.ts`).
- **Direct Holdings:** When each investor has a dedicated Stellar account address, the position is compared directly to that account's replayed ledger balance.
- **Omnibus / Nominee Accounts:** Multiple beneficial owners on the register may share a single institutional custodian or omnibus account (e.g., `G_CUSTODY_OMNIBUS`). Concord groups register rows by `account`, accumulating `entry.units += p.units` and preserving the list of `holderIds` (`reconcile.ts:94-98`). The aggregated register units are reconciled against the single on-chain balance.

### Ignore List
- Configured via asset settings (`options.ignore`).
- Used for operational addresses excluded from the public register, such as an issuer treasury account or unissued pool (`G_ISSUER_TREASURY`).
- Ignored addresses are bypassed in both the register sum and on-chain balance calculations (`reconcile.ts:78, 104`), preventing false breaks.

### Tolerance & Supply Invariants
- **Tolerance:** Configurable via `options.tolerance` (default `0n`). Per-address differences satisfying `abs(chainUnits - registerUnits) <= tolerance` are treated as matched.
- **Gross Difference:** The sum of absolute per-address differences across all unmatched lines (`grossDifference = sum(abs(difference))`).
- **Supply Check:** Concord compares the aggregate on-chain circulating supply with the total register units:
  ```
  abs(chainSupply - registerTotal) > tolerance => SUPPLY_MISMATCH
  ```

---

## 3. Movement Reconciliation Mechanics

Movement reconciliation verifies individual transactions between the off-chain journal CSV (`JournalEntry`) and on-chain events (`AssetEvent`):

1. **Pass 1 — Exact Transaction Hash Matching (`by: "tx_hash"`):**
   - Matches journal rows containing a populated `tx_hash` against the corresponding on-chain transaction.
   - If the transaction exists on-chain but the transacted amount differs from the journal units, Concord flags a `MOVEMENT_AMOUNT_MISMATCH`.
2. **Pass 2 — Attribute Matching within 24h Window (`by: "attributes"`):**
   - For entries without a transaction hash or unmatched in Pass 1, Concord searches for unconsumed ledger events matching:
     - `sameParties`: Event kind matches journal type (`mint` -> `issue`, `transfer` -> `transfer`, `burn`/`clawback` -> `redeem`).
     - Exact `from` and `to` account addresses.
     - Units within tolerance (`abs(entry.units - ev.amount) <= tolerance`).
     - Timestamp proximity within a 24-hour sliding window (`windowMs = 86_400_000`). Closest timestamp wins.
3. **Movement Breaks:**
   - On-chain event with no matching journal entry -> `UNRECORDED_MOVEMENT`.
   - Journal entry with no matching on-chain transaction -> `UNSETTLED_ENTRY`.

---

## 4. Worked Numeric Example & Break Matrix

The following worked example illustrates how a single reconciliation run against a synthetic asset (`SYM`) produces each break type.

### Asset Configuration
- **Decimals:** 2 (`1.00 SYM` = `100` base units).
- **Snapshot Cutoff (`asOf`):** `2026-10-01T00:00:00Z`.
- **Ignore List:** `G_ISSUER_POOL`.

### Initial Replayed Ledger State (`asOf: 2026-10-01T00:00:00Z`)
| Account Address | Balance | Authorized | History Status | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `G_HOLDER_1` | 1,500 units | Active | Complete | Individual investor |
| `G_OMNIBUS` | 5,000 units | Active | Complete | Custodian omnibus account |
| `G_HOLDER_2` | 500 units | Active | Complete | Unlisted on-chain account |
| `G_HOLDER_3` | 0 units | Active | Complete | Zero balance account |
| `G_HOLDER_4` | 800 units | Frozen | Complete | Frozen on-chain via clawback/trustline flag |
| `G_HOLDER_5` | -100 units | Active | **Incomplete** | Negative balance during replay (needs baseline) |
| `G_ISSUER_POOL`| 10,000 units| Active | Complete | Configured in ignore list |

### Official Register Snapshot (`asOf: 2026-10-01T00:00:00Z`)
| Holder ID | Account Address | Units | Status | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `H-001` | `G_HOLDER_1` | 1,000 units | active | Differs by +500 from chain |
| `H-002` | `G_OMNIBUS` | 3,000 units | active | Omnibus sub-account A |
| `H-003` | `G_OMNIBUS` | 2,000 units | active | Omnibus sub-account B (sum = 5,000 units, matches) |
| `H-004` | `G_HOLDER_3` | 200 units | active | Register shows 200, chain shows 0 |
| `H-005` | `G_HOLDER_4` | 800 units | active | Register active, chain frozen |
| `H-006` | *(unmapped)* | 300 units | active | Beneficial owner with no Stellar address |
| `H-007` | `G_HOLDER_5` | 100 units | active | Historical gap on ledger |

---

### Reconciliation Results & Break Classifications

| Break Type | Severity | Affected Entity | Chain Value | Register Value | Difference | Diagnostic Explanation |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- |
| **`QUANTITY_MISMATCH`** | High | `G_HOLDER_1` | 1,500 units | 1,000 units | +500 units | Ledger holds 500 units more than the register records (`reconcile.ts:151`). |
| **`MISSING_IN_REGISTER`** | High | `G_HOLDER_2` | 500 units | 0 units | +500 units | Account exists and holds tokens on-chain, but is absent from the official register (`reconcile.ts:133`). |
| **`MISSING_ON_CHAIN`** | High | `G_HOLDER_3` | 0 units | 200 units | -200 units | Register credits holder with 200 units, but on-chain account has zero balance (`reconcile.ts:141`). |
| **`UNMAPPED_HOLDER`** | Medium | `H-006` | N/A | 300 units | -300 units | Investor is recorded on the register with positive units but no associated on-chain address (`reconcile.ts:84`). |
| **`STATUS_MISMATCH`** | Medium | `G_HOLDER_4` | Frozen | Active | 0 units | Balances match (800 units), but trustline authorization differs (`reconcile.ts:160`). |
| **`SUPPLY_MISMATCH`** | High | Aggregate | 7,700 units | 7,400 units | +300 units | Total circulating supply (excluding ignored pool) deviates from aggregate register units (`reconcile.ts:174`). |
| **`INCOMPLETE_HISTORY`**| High | `G_HOLDER_5` | -100 units | 100 units | -200 units | Replay encountered a negative balance due to ledger retention limits; requires opening baseline (`reconcile.ts:187`). |

### Movement Reconciliation Breaks (Journal vs Ledger)
| Break Type | Severity | Reference / Event | Chain Units | Register Units | Diagnostic Explanation |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **`MOVEMENT_AMOUNT_MISMATCH`** | High | Ref: `J-101`, Tx: `a1b2...` | 1,000 units | 1,200 units | Transaction hash matches, but journal recorded 1,200 units while on-chain transaction transferred 1,000 units (`movements.ts:156`). |
| **`UNRECORDED_MOVEMENT`** | High | Event: `ev-502` (`transfer`) | 250 units | N/A | Token transfer observed on ledger between `G_A` and `G_B` with no corresponding journal record (`movements.ts:226`). |
| **`UNSETTLED_ENTRY`** | High | Ref: `J-103` (`issue`) | N/A | 500 units | Transfer agent instructed issuance to `G_C`, but no matching on-chain mint occurred within 24 hours (`movements.ts:204`). |
