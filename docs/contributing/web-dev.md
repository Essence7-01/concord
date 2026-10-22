# Web development: running the dashboard locally

This guide is for front-end contributors working on the dashboard in
`apps/web`. It covers the ports, how to start a dev server, how to get data into
the dashboard, the browser checks the PR template asks for, and the errors you
are most likely to hit.

Every statement below was checked against the code in this repository. Where
something lives in a specific file, the path is given so you can confirm it yourself.

## Ports

The dev server is Vite. It serves the dashboard on **4401** and proxies API
requests to the API on **4400**. The proxy is configured in the Vite config for
`apps/web` (`apps/web/vite.config.ts`). The API port is the same one `pnpm start`
uses, so a production build and a dev server never disagree on the address.

- Dashboard (dev): http://127.0.0.1:4401
- API: http://127.0.0.1:4400

Open the *4401* address in the browser. Opening *4400* in dev gives you the API
only, not the dashboard.

## Start the dev server

From the repository root:

```sh
pnpm install
pnpm dev
```
`pnpm dev` runs the API and the dashboard together with reload (see the scripts in
the root `package.json`). The API listens on 4400 and Vite on 4401. If you only
want the front end, run the API separately and the Vite dev server from
`apps/web`, but `pnpm dev` is the supported path and the one the PR template assumes.

The dev server writes to the same data directory as `pnpm start`. Accounts and
sessions live in `data/control.db`; each workspace is a separate SQLite file
under `data/orgs`. Deleting that directory resets your local installation.

## Create a workspace

A fresh installation has no accounts. Open the dashboard at 4401 and sign up
with an email and password. With the default sign-up mode, the first sign-up creates
a workspace and makes you its owner. If the server was started with
``CONCORD_SIGNUP=code`, you need a sign-up code from `pnpm concord signup-code`
before the form will accept you. See the root README ("Run it" and "Accounts and
workspaces") for the auth modes.

A new workspace is empty: Concord ships no sample data. To see anything on the
dashboard you need at least one watched asset, and for reconciliation you also need
the register side.

## Watch a testnet asset

The network switch is at the top left of the dashboard. Set it to **Testnet** before
watching an asset, otherwise you are watching mainnet and the asset will not be
found.

To watch a testnet asset you need its issuer address and the asset code (for a
SEP-41 token, the contract address instead). The watch form is on the assets
page. The API accepts the same input as `pnpm concord watch`; see the root
README ("Command line") for the arguments.

After watching, the indexer reads opening balances from Horizon and then follows
CAP-67 events from that ledger on. On a busy testnet asset this takes a few seconds;
the holdings page refreshes as events arrive. If you need a quiet asset to watch, issue
one yourself with the demo script below.

## Load the demo files

`pnpm demo:testnet` issues a testnet fund share and runs subscriptions, a cash
dividend, a transfer, a freeze, a clawback, a redemption and a 2:1 split against
it. It then writes a register, journal and instruction file to `data/demo/` and
prints what to watch. The script never opens a Concord database: you watch the
asset with the network set to Testnet and upload the files by hand, the way a
user would. The books it writes are invented, and exist for development only.

To use them in the dashboard:

1. Run `pnpm demo:testnet` and read the output. It prints the issuer and asset
code to watch, and the paths of the files it wrote.
2. In the dashboard, switch the network to **Testnet** and watch the asset it printed.
3. On the register import form, upload the register CSV from `data/demo/`. The
import runs a reconciliation immediately and the breaks page shows the disagreements
the script built in.
4. Upload the journal and instructions files the same way, from their respective
import forms, to exercise the movements and controls views.

The demo files are invented and contain no real holder data. Do not commit real
holder lists or real account identifiers into the repo.

## Browser checks the PR template asks for

The PR template asks for a browser check of the dashboard changes. Before opening a
PR, run through this list on 4401 and paste the results into the PR description:

- Sign in and out, and reload the page while signed in.
- Switch between Mainnet and Testnet and confirm the asset list refreshes.
- Watch an asset and confirm its holdings appear.
- Upload a register and confirm the breaks page shows the result.
- Open a break, acknowledge it and resolve it with a note; confirm the sign-off
state changes and reopens if the figures move.
- Visit the corporate actions, controls and audit export pages and confirm they render
with the data you loaded.
- Check the browser console for errors and network requests for failed calls to
the API.

If your change is visual, include a screenshot in the PR. Do not include screenshots
containing real holder data; use the demo files instead.

## Common errors

- **4401 refuses to connect / connection refused.** The Vite dev server is not
running. Start it with `pnpm dev` from the repository root. Opening 4400 instead of
4401 shows the API, not the dashboard.
- **4400 is already in use.** Another Concord process (or anything else) is
listening on the API port. Stop it before starting `pnpm dev`. On macOS, AirPlay
Receiver sometimes holds 5000 and 7000; neither port is used by Concord.
- **API requests return 404 / 502 from the dashboard.** The Vite proxy forwards to
4400. If the API is not up, the proxy returns an error and the dashboard shows a
failed request in the network tab. Start the API alongside Vite with `pnpm dev`.
- **Sign-up is rejected.** The server is running with `CONCORD_SIGNUP=code` and you
have not entered a code. Generate one with `pnpm concord signup-code`, or restart
the server with `pnpm dev` and the default mode.
- **The asset you want to watch is not found.** Check the network switch at the
top left. A testnet asset watched while the dashboard is on Mainnet will not be found.
- **Holdings are empty after watching.** The indexer is still reading opening balances
or the asset has no trustlines yet. Wait a few seconds and reload. If it stays empty,
check the asset's settings page for an indexer error.
- `**The dashboard says history is incomplete.** Stellar RPC keeps about seven days of
events. An asset that has been active longer than that has history that cannot be
queried. This is expected and documented in the root README ("Limits"). Use **Rebuild
history** in the asset's settings to restart from fresh opening balances.
- **Changes to the dashboard do not appear.** Vite reloads on save. If it does not,
check the Vite terminal for a compile error, then reload the page. A full restart of
`pnpm dev` clears a stuck dev server.
