# Glossary of Stellar terms used in Concord

This glossary is for finance, compliance, and transfer agent readers who are new to Stellar. It explains the core blockchain concepts and protocols that Concord relies on to index, replay, and reconcile tokenized securities against official registers.

---

## 1. CAP-67 (Protocol 23 Unified Events)

**Core Architecture Proposal 67** standardizes event emissions across classic Stellar operations and Soroban smart contracts starting in Stellar Protocol 23.

Prior to CAP-67, tracking token transfers on classic Stellar required inspecting individual ledger transaction operations (`Payment`, `ChangeTrust`, `Clawback`, `SetTrustLineFlags`). CAP-67 unifies this by having classic asset operations emit standard Soroban-compatible contract events.

Concord's indexer consumes CAP-67 events exclusively (`packages/core/src/events.ts:1-2`). The event set covers:
- `transfer`: balance movement between two addresses.
- `mint`: creation of new units by or on behalf of an issuer.
- `burn`: destruction of units.
- `clawback`: administrative revocation of units from an account.
- `set_authorized`: modifications to a holder's regulatory authorization status.

In Concord's event decoder (`services/api/src/chain.ts:108-149`), event topics follow `[name, ...addresses, sep11_asset]`. Because earlier releases placed the admin first on certain operations, Concord deterministically evaluates the subject address as the final address in the topics array (`services/api/src/chain.ts:118`).

---

## 2. SEP-41 (Token Interface)

**Stellar Ecosystem Proposal 41** defines the standard interface for token contracts on Stellar's Soroban smart contract platform. It specifies functions such as `transfer`, `balance`, `decimals`, `clawback`, and `mint`.

In Concord:
- A SEP-41 token is identified by a 56-character contract ID starting with `C` (`services/api/src/chain.ts:83`).
- Unlike classic Stellar assets which are fixed at seven decimal places, arbitrary SEP-41 contracts can define custom decimal precisions (`services/api/src/amount.ts:1`, `services/api/src/chain.ts:35`).
- SEP-41 contract tokens emit events formatted identically to CAP-67, allowing Concord to use a single event replay engine across classic assets and smart contract tokens (`packages/core/src/events.ts`).

---

## 3. SEP-11 Asset

**Stellar Ecosystem Proposal 11** defines the canonical string format used across the Stellar ecosystem to describe classic assets:

$$\text{AssetCode}:\text{IssuerPublicKey}$$

For example:
- `USDC:GA5Z...`
- `BENJI:GBUQ...`
- `XLM` (the native asset, which has no issuer)

Asset codes are 1 to 12 alphanumeric characters, and the issuer is the 56-character Ed25519 public key starting with `G`. In Concord, `resolveAsset` parses this format and verifies the issuer's public key encoding before looking up contract IDs or indexing events (`services/api/src/chain.ts:80-89`). In CAP-67 event payloads, the SEP-11 asset string forms the trailing topic element.

---

## 4. Trustline

On classic Stellar, an account cannot be credited with a non-native asset until the account explicitly establishes a **trustline** for that asset. A trustline is a ledger entry on the holder's account that:
1. Expresses explicit consent to hold the specific `CODE:ISSUER` token.
2. Specifies an optional maximum holding limit (credit limit).
3. Tracks the account's current balance, authorized state, and liabilities.

For regulated securities, trustlines prevent unsolicited airdrops or unauthorized custody. Concord reads trustlines from Horizon (`/accounts?asset=CODE:ISSUER`) to build the opening baseline of all holder positions when watching a classic asset (`services/api/src/chain.ts:371-400`).

---

## 5. Authorisation Flags (`auth_required`, `auth_revocable`, `auth_clawback_enabled`)

Classic Stellar allows asset issuers to set protocol-level flags on their issuing account to enforce regulatory and transfer restrictions:

- **`auth_required` (`0x1`):** Requires the issuer to explicitly authorize each holder's trustline before the holder can receive or transfer units. Unapproved holders have `is_authorized = false`.
- **`auth_revocable` (`0x2`):** Grants the issuer the ongoing legal and technical capability to freeze an existing trustline at any time by setting authorization to `false` (`set_authorized`). Frozen accounts cannot send or receive units.
- **`auth_clawback_enabled` (`0x8`):** Enables the issuer to seize or burn units directly from a holder's account (`clawback`), even without the holder's signature. This is used in regulated funds for court orders, sanctions compliance, or fraud rectification.

### The Controls Log in Concord
Every authorization toggle (`set_authorized`) and clawback on-chain emits a CAP-67 event. Concord matches each event against uploaded compliance instructions issued in the preceding 72 hours (`packages/core/src/controls.ts:8-51`, `services/api/src/concord.ts:621-625`). Any freeze, unfreeze, or clawback that executed on-chain without a corresponding signed instruction is flagged as a compliance control break.

---

## 6. Contract ID of a Classic Asset (Stellar Asset Contract)

Under Stellar Protocol 20+, every classic Stellar asset (`CODE:ISSUER`) has a corresponding, deterministically derived Soroban smart contract identifier known as the **Stellar Asset Contract (SAC)**.

Concord derives this contract identifier using the network passphrase:
```ts
// services/api/src/chain.ts
new Asset(code, issuer).contractId(passphrase);
```
Deriving the SAC contract ID allows Concord to query Soroban RPC endpoints (`getEvents`) for classic assets using the same contract ID filtering mechanism as native Soroban smart contracts (`services/api/src/chain.ts:88, 350`).

---

## 7. Horizon

**Horizon** is the client-facing HTTP REST API server for the classic Stellar network. It provides historical querying, account balances, and transaction submission.

In Concord:
- Horizon is queried via `services/api/src/chain.ts:274, 325-330` through an endpoint pool (`EndpointPool`) that handles failover and rate limiting.
- Concord uses Horizon's `/accounts?asset=CODE:ISSUER` endpoint to stream opening account balances when generating an asset's baseline (`services/api/src/chain.ts:376-400`).
- Concord also queries Horizon `/assets?asset_code=...` to search for classic assets by code and retrieve issuance flags (`services/api/src/chain.ts:244-250`).

---

## 8. Stellar RPC (Soroban RPC)

**Stellar RPC** is the JSON-RPC 2.0 interface that provides state and event access for Soroban contracts and CAP-67 events.

Concord interacts with Stellar RPC via:
- `getHealth`: Reports the latest ledger sequence and the oldest ledger currently retained in the RPC node's rolling window (`services/api/src/chain.ts:331-340`).
- `getEvents`: Queries filtered event pages by contract ID and ledger bounds (`services/api/src/chain.ts:342-369`).

Unlike Horizon instances that may maintain full ledger histories, public and commercial Stellar RPC nodes typically maintain a rolling retention window of approximately **seven days** (around 120,000 ledgers) (`services/api/src/config.ts:25-35`, `docs/ARCHITECTURE.md:78-80`).

---

## 9. Ledger

The **ledger** is the fundamental consensus state in Stellar, equivalent to a block in other blockchain architectures.
- A new ledger is closed by the Stellar Consensus Protocol (SCP) approximately every **5 seconds**.
- Each ledger is identified by an incremental 32-bit sequence number (integer) and an ISO-8601 close timestamp (`closedAt`).
- All holdings replay and reconciliation calculations in Concord anchor to specific ledger sequences (`packages/core/src/holdings.ts:63-74`).
- When reconciling against a register export, Concord takes an `asOf` date or ledger, replays all chain events up to that exact ledger cutoff, and compares the resulting on-chain balance with the register's stated units (`packages/core/src/reconcile.ts`).

---

## 10. Muxed Account (`M...`)

A **Multiplexed Account (muxed account)**, defined in **CAP-27** and **SEP-23**, is an address format that combines a standard Stellar account (`G...`) with a 64-bit integer routing ID (memo ID).

- Muxed addresses start with the letter `M` and are 69 characters long.
- They are commonly used by institutional custodians, brokers, and exchanges to pool customer holdings in a single omnibus on-chain account while attributing incoming deposits to specific sub-accounts without separate base reserves.
- In Concord's address matcher regex:
  ```ts
  // services/api/src/chain.ts:101-102
  const ADDRESS = /^[GCMLB][A-Z2-7]{55,}$/;
  ```
  `M` represents muxed addresses. When a transfer specifies a muxed destination, Concord unwraps the destination map to extract the underlying transfer value (`services/api/src/chain.ts:135-136`).
- In register reconciliation, multiple register holders can be mapped to the same underlying omnibus Stellar account (`README.md:120`).

---

## 11. Liquidity Pool (`L...`)

A **Liquidity Pool** is an automated market maker (AMM) reserve on the Stellar protocol (introduced in **CAP-38**).
- Liquidity pool identifiers begin with `L`.
- Balances deposited into liquidity pools are held by the pool contract rather than an individual user account trustline.

### Accounting Impact in Concord
Horizon's `/accounts` endpoint pages through individual account trustlines, but does **not** enumerate balances held inside liquidity pool shares or smart contract storage (`services/api/src/chain.ts:373-375`, `README.md:134-135`).

Consequently, if a tokenized asset has units deposited into an AMM pool, Concord's opening baseline will reflect only individual trustline balances. The difference is recognized as unmapped circulating supply until pool movements are accounted for.

---

## 12. Claimable Balance (`B...`)

A **Claimable Balance** (introduced in **CAP-23**) allows an account to transfer units to a ledger holding entry that can be claimed later by designated recipient accounts according to defined predicates (such as time locks).
- Claimable balance identifiers begin with `B`.
- While pending claim, the tokens reside in the claimable balance ledger entry, outside of the sender's and receiver's account trustlines.

### Accounting Impact in Concord
Because Horizon `/accounts` queries do not return tokens currently escrowed in claimable balance entries, an opening baseline taken while balances are in transit will understate total on-chain supply by the escrowed quantity (`services/api/src/chain.ts:373-375`, `README.md:134-135`). Once claimed, the tokens enter a holder's trustline and are tracked via standard CAP-67 transfer events.

---

## 13. Baseline (Opening Baseline)

A **Baseline** is an initial snapshot of holder balances for an asset at a designated ledger sequence number (`services/api/src/chain.ts:18-21`):

```ts
export interface Baseline {
  ledger: number;
  openings: Map<string, Opening>;
}
```

### Why Baselines are Necessary
Because Stellar RPC nodes retain events for only about seven days, Concord cannot replay an asset's entire history from genesis (ledger 1) using `getEvents` alone.

When watching a classic asset (`concord watch`, `services/api/src/concord.ts:405-420`):
1. Concord queries Horizon for all existing trustline balances at the current ledger.
2. It stores these balances as opening positions at that `baseline_ledger`.
3. It then starts indexing CAP-67 events from `baseline_ledger + 1` onward.
4. During holdings replay, any event prior to a holder's opening cutoff is skipped to prevent double counting (`packages/core/src/holdings.ts:72-78`).

Contract tokens (SEP-41) that are not classic assets do not expose a trustline endpoint in Horizon; they must be indexed within the RPC's event retention window or initialized without a baseline (`services/api/src/concord.ts:472`, `README.md:137-140`).
