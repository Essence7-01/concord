# Pull-Request Review Checklist

This checklist expands the invariants listed in [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md) alongside the architectural and security rules enforced across Concord. Reviewers and maintainers should verify each item that applies to a pull request before merging.

---

## 1. Amounts Stay `bigint` in the Smallest Unit

- **No floating-point arithmetic:** Never use `number`, `parseFloat`, `Math.round`, or `toFixed` for token balances, movements, entitlements, or differences.
- **Exact decimal parsing:** User-supplied and ledger strings must pass through `parseUnits(input, decimals)` and `formatUnits(value, decimals)` in [`packages/core/src/amount.ts`](../../packages/core/src/amount.ts).
- **Reject excess precision:** `parseUnits` throws when a decimal string carries more fractional digits than the asset's `decimals` setting (`packages/core/src/amount.ts#L19-L21`). Never silently round or truncate input precision—a register with excess decimal places is a reconciliation issue that must be surfaced.
- **Rational corporate-action math:** Dividend rates and split ratios use `Ratio` (`parseRatio`) and `mulDiv(value, num, den, rounding)` with an explicit `Rounding` mode (`"floor"` or `"half-up"`, `packages/core/src/amount.ts#L39-L60`).
- **Database and JSON representation:** SQLite columns store smallest-unit integers or formatted decimal strings as `TEXT` (`services/api/src/db.ts#L9`, `services/api/src/schema.ts`), and HTTP responses serialize formatted decimal strings via `formatUnits`.

### What to check in the diff
- Flag any `Number(...)` call on a `units`, `amount`, `balance`, or `supply` field (`Number` is acceptable only for integer metadata like `decimals`, `ledger`, or row IDs).
- Verify that CSV parsers pass the asset's `decimals` down to `parseUnits`.

---

## 2. `packages/core` Purity (Zero I/O)

- **Pure functional accounting:** [`packages/core`](../../packages/core/src/index.ts) computes holdings replay, position and movement reconciliation, corporate-action entitlements, and control-log matching from in-memory arguments only.
- **No environment dependencies:** Code under `packages/core/src/` must not import `node:fs`, `node:sqlite`, `node:http`, `fetch`, `process.env`, `Date.now()`, or `new Date()` (with no arguments).
- **Deterministic timestamps:** When a cutoff or window check needs the current time, the caller in `services/api` passes an explicit ISO-8601 timestamp (for example, `ControlsOptions.asOf` in `packages/core/src/controls.ts#L100`).

### What to check in the diff
- Inspect imports in `packages/core/src/*.ts` and `packages/core/package.json`. Only internal relative modules may be imported at runtime.

---

## 3. Append-Only Database Migrations

- **Never edit a shipped migration:** Schema arrays in [`services/api/src/schema.ts`](../../services/api/src/schema.ts) (`ORG_MIGRATIONS` for per-workspace databases and `CONTROL_MIGRATIONS` for `control.db`) are indexed by SQLite's `PRAGMA user_version`.
- **How `Db.migrate` runs:** [`services/api/src/db.ts`](../../services/api/src/db.ts#L30-L57) reads `PRAGMA user_version` and executes only entries at index `>= version`. Editing an earlier string will not run on existing databases and will cause schema drift.
- **Foreign-key verification:** `Db.migrate` disables `foreign_keys` during the migration step (to allow table rebuilds), runs `PRAGMA foreign_key_check` before committing, and rolls back if any dangling reference exists (`services/api/src/db.ts#L42-L55`).

### What to check in the diff
- Any change to [`services/api/src/schema.ts`](../../services/api/src/schema.ts) must append a new SQL string to the end of `ORG_MIGRATIONS` or `CONTROL_MIGRATIONS`.
- Verify that [`docs/schema.md`](../schema.md) is updated to reflect new tables, columns, or indexes.

---

## 4. No Sample or Invented Data in the Product

- **Empty new workspaces:** A newly created workspace has zero watched assets, zero registers, and zero breaks. All chain state comes from Stellar RPC / Horizon, and all book state comes from user-uploaded CSVs.
- **Demo isolation:** The testnet practice script in [`services/api/src/demo/testnet.ts`](../../services/api/src/demo/testnet.ts) is a standalone CLI tool that writes files to `data/demo/` and never opens a Concord database. This boundary is enforced by the `"keeps the testnet practice script away from every database"` test in [`services/api/test/tenancy.test.ts`](../../services/api/test/tenancy.test.ts).

### What to check in the diff
- Ensure no seed rows, placeholder holders, or mock assets are inserted during workspace creation, migration, or UI rendering.
- Ensure documentation and test fixtures do not contain real customer or non-public holder PII.

---

## 5. Tenant Isolation and Session Boundaries

- **Separate SQLite file per workspace:** [`services/api/src/tenants.ts`](../../services/api/src/tenants.ts) stores each organisation's data in `data/orgs/<orgId>.db`, while accounts and sessions live in `data/control.db`.
- **Authenticated router:** Every workspace route in [`services/api/src/api.ts`](../../services/api/src/api.ts#L90-L100) is mounted on the `priv` router, which validates the session cookie, checks the `x-concord-org` header against `session.org.id` (`409 Conflict` on mismatch), and binds `c.get("ws")` to `tenants.forOrg(session.org.id)`.
- **Role enforcement:** Destructive or administrative routes (`POST /api/assets`, `DELETE /api/assets/:id`, team invites, member removal, workspace deletion) must check `requireOwner(c)` (`services/api/src/api.ts#L36-L38`).

### What to check in the diff
- Confirm new workspace endpoints are mounted on `priv` (not `app`) and access data exclusively through `c.get("ws")`.
- Confirm state-changing routes verify owner vs. member permissions where appropriate and pass `actor(c)` for audit attribution.
- Check that cross-tenant isolation is covered in [`services/api/test/tenancy.test.ts`](../../services/api/test/tenancy.test.ts).

---

## 6. Rate Limiting and Request Hardening on New Routes

- **Tiered rate limits:** [`services/api/src/api.ts`](../../services/api/src/api.ts#L67-L79) applies sliding-window rate limiters from [`services/api/src/security.ts`](../../services/api/src/security.ts) to all `/api/*` requests except `/api/health`:
  - `small` (20 req / 60s): `/api/auth/*` endpoints.
  - `upload` (30 req / 60s): CSV import routes matching `/\/(registers|journal|instructions)$/`.
  - `normal` (240 req / 60s): all other API routes.
- **Body size and CSRF checks:** Body limits (`16 KiB` for auth, `256 KiB` for JSON, `10 MiB` for CSV uploads in `services/api/src/api.ts#L102-L107`) and same-origin `Origin` verification (`sameOrigin` in `services/api/src/security.ts`) protect mutating requests.

### What to check in the diff
- If a new route accepts large payloads or performs expensive work (such as bulk parsing or external lookups), verify that the route path matches the appropriate rate-limit tier and body-size cap in `services/api/src/api.ts`.

---

## 7. Tests That Fail Without the Change

- **No network in tests:** Unit and service tests must use `FakeChain` and `memoryStore` from [`services/api/test/helpers.ts`](../../services/api/test/helpers.ts).
- **Order independence:** CI runs `pnpm test --sequence.shuffle` (`.github/workflows/ci.yml#L34`). Tests must not rely on shared mutable state or execution order.
- **Regression proof:** Every bug fix must include a test case in `packages/core/test/core.test.ts`, `services/api/test/service.test.ts`, or `services/api/test/tenancy.test.ts` that fails when the fix is reverted.

### What to check in the diff
- Verify that `pnpm build && pnpm typecheck && pnpm test` pass.
- For UI changes in `apps/web/src/`, verify accessibility and smoke tests (`pnpm --filter @concord/web test:a11y` and `pnpm e2e`) remain green.

---

## 8. Documentation and Limit Updates

- **Keep docs in sync with code:** If a pull request changes CLI flags, environment variables, database tables, break types, or architectural limits, the corresponding documentation (`README.md`, `.env.example`, `docs/cli.md`, `docs/schema.md`, or `docs/ARCHITECTURE.md`) must be updated in the same pull request.
- **Read-only posture:** Concord never holds signing keys or submits value-moving transactions (`README.md#L205`). Reject changes that introduce transaction signing inside the product runtime.
