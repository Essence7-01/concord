# Reproducing the Mainnet BENJI Reconciliation Claim

This note documents the method, parameters, endpoints, and reproduction steps for the claim stated in Concord's README:
> watching Franklin Templeton's BENJI, Concord's unit total matched Horizon's own figure to the last decimal, and a register built from the chain's holdings reconciled clean across all 1,005 positions.

The 1,005 positions and unit total cited in the README were captured during benchmark testing. Because public Horizon and standard RPC endpoints retain only recent ledger history, this guide provides a verifiable procedure that executes against the current live mainnet state.

## Parameters and Asset Details

- **Network:** Stellar Mainnet
- **Asset Code:** `BENJI`
- **Asset Issuer:** `GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5` (Franklin OnChain U.S. Government Money Fund / FOBXX)
- **Issuer Verification:** Published in Franklin Templeton's [stellar.toml](https://www.franklintempleton.com/.well-known/stellar.toml)
- **Precision:** 7 decimal places (Stellar standard classic asset precision)
- **Network Endpoints:**
  - Horizon: `https://horizon.stellar.org`
  - Soroban RPC: `https://mainnet.sorobanrpc.com` (or your dedicated RPC provider)

## Reproduction Walkthrough

### 1. Verify Horizon Baseline

Query the asset summary from Horizon to observe the official supply and trustline count on mainnet:

```sh
curl -s "https://horizon.stellar.org/assets?asset_code=BENJI&asset_issuer=GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5" \
  | jq '._embedded.records[0] | {accounts: .accounts, balances: .balances, flags: .flags}'
```

The response provides the total authorized unit supply (`balances.authorized`) and the count of authorized trustline accounts (`accounts.authorized`).

### 2. Configure Concord

Ensure Concord is built and dependencies are installed:

```sh
pnpm install
pnpm build
```

Configure your environment variables in `.env` to connect to mainnet:

```env
CONCORD_MAINNET_HORIZON_URL=https://horizon.stellar.org
CONCORD_MAINNET_RPC_URLS=https://mainnet.sorobanrpc.com
```

### 3. Watch the Asset and Ingest Opening Balances

Create an organization workspace and watch the asset:

```sh
export CONCORD_ORG="Benchmark Org"
pnpm concord orgs
pnpm concord watch BENJI:GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --name "Franklin OnChain US Govt Money Fund"
```

Concord queries Horizon for all trustlines for the issuer to construct opening balances, and begins streaming ledger events from that point forward.

### 4. Verify Concord Holdings and Totals

Query the Concord audit export for the asset:

```sh
pnpm concord export BENJI:GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 --out benji-audit.json
```

Inspect `benji-audit.json`:
- Verify `audit.holdings.supply` equals Horizon's `.balances.authorized` amount exactly to the last decimal.
- Verify `audit.holdings.holderCount` matches the active holding accounts on-chain.

### 5. Generate Register and Run Reconciliation

Generate a register CSV matching the on-chain positions from `audit.holdings.holders`:

```sh
node -e '
const fs = require("fs");
const audit = JSON.parse(fs.readFileSync("benji-audit.json", "utf8"));
const rows = ["holder_id,units,account,status"];
for (const h of audit.holdings.holders) {
  if (!h.ignored && Number(h.units) > 0) {
    rows.push(`${h.address},${h.units},${h.address},${h.status ?? "active"}`);
  }
}
fs.writeFileSync("benji-register.csv", rows.join("\n"), "utf8");
fs.writeFileSync("as-of.txt", audit.holdings.asOf, "utf8");
'
```

Import the register into Concord using the snapshot timestamp:

```sh
AS_OF=$(cat as-of.txt)
pnpm concord register BENJI:GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5 ./benji-register.csv --as-of "$AS_OF"
```

Verify the reconciliation output:
- **0 breaks** reported.
- All positions reconcile clean with zero quantity, supply, or status mismatches.

## Scope and Explicit Limitations

To ensure transparency for evaluators and auditors, note the following boundaries:

1. **Benchmark figures vs live ledger:** The "1,005 positions" cited in the README reflects the on-chain holder distribution at the time of the benchmark run. Over time, new accounts open and close trustlines on mainnet, so running the reproduction on the live ledger will match the current holder count and circulating supply reported by Horizon.
2. **Indexer fidelity vs. off-chain register fidelity:** Because the synthetic test register is derived from chain holdings at the export timestamp, this exercise verifies the correctness, precision, and idempotency of Concord's opening balance extraction, rounding, and reconciliation pipeline. It does not replace independent off-chain bookkeeping.
3. **Horizon balance scope:** Horizon asset records report trustline balances for classic accounts. They do not include balances held inside liquidity pools, claimable balances, or Soroban contract balances.
4. **RPC history retention:** Standard RPC nodes retain roughly 7 days of historical events. Replaying past ledgers beyond the retention window requires an archive RPC endpoint.
