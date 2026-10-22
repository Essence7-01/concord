# Maintainers Guide

This guide covers daily issue triage, pull-request review and merge rules, release preparation, incident handling for security and Code of Conduct reports, and dependency maintenance for Concord.

---

## 1. Issue Triage Routine

Review new issues regularly to keep the backlog actionable and aligned with the product scope in [`BRIEF.md`](../BRIEF.md) and [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md).

1. **Sanitize sensitive data first:** If an issue, log excerpt, or screenshot includes real customer names, holder addresses, or session tokens, redact the content immediately per [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md#L12-L13). If a reporter posts an exploitable vulnerability in public, delete or hide the issue and direct them to private reporting ([`SECURITY.md`](../SECURITY.md#L8-L9)).
2. **Check product boundaries:** Concord is read-only (`README.md#L205`, `CONTRIBUTING.md#L73-L74`), runs as a single process backed by local SQLite files (`services/api/src/db.ts`), and sends no email (`README.md#L163`). Feature requests that require holding signing keys, submitting value-moving transactions, or adding external database servers should be closed or converted into design discussions before anyone writes code.
3. **Verify bug reports:** Confirm the report states the commit or build, the network (`mainnet` or `testnet`), and steps to reproduce using CLI commands (`pnpm concord ...`) or a minimal CSV fixture.
4. **Apply labels:**
   - **Area:** `area: core`, `area: api`, `area: web`, `area: docs`, or `area: ops`.
   - **Type:** `bug`, `enhancement`, `documentation`, `testing`.
   - **Difficulty:** `good first issue`, `intermediate`, or `advanced`.
5. **Prevent duplicate work:** When a contributor asks to work on an issue, assign one contributor at a time and note if an open pull request already covers the change.

---

## 2. Pull-Request Review and Merge Policy

### Review Gates

Before merging any pull request, verify both the automated checks in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and the architectural invariants in [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md):

- **CI job `check` passes:**
  - `pnpm install --frozen-lockfile`
  - `pnpm build` (builds `@concord/core` before `@concord/api` and `@concord/web`)
  - `pnpm typecheck`
  - `pnpm test` and `pnpm test --sequence.shuffle` (verifies tests do not depend on execution order)
  - `pnpm --filter @concord/core test:coverage` and `pnpm --filter @concord/api test:coverage`
  - `pnpm --filter @concord/web test:a11y` (Playwright + axe accessibility checks) and `pnpm e2e`
- **CI job `docker-smoke` passes:** Builds the production [`Dockerfile`](../Dockerfile), mounts `/data`, waits for `/api/health` to become healthy, and probes `/` and `/api/health`.
- **Invariants hold:**
  - Money and token units stay `bigint` in the smallest unit (`packages/core/src/amount.ts`); excess decimal precision is rejected, never rounded.
  - `packages/core` performs zero I/O (no filesystem, network, clock, or SQLite imports).
  - Database schema changes in [`services/api/src/schema.ts`](../services/api/src/schema.ts) append a new entry to `ORG_MIGRATIONS` or `CONTROL_MIGRATIONS` and never edit a shipped entry.
  - No sample or invented holder records are reachable in the product (`services/api/test/tenancy.test.ts`).
  - Workspace routes enforce tenant isolation through `c.get("ws")` and `x-concord-org` checks (`services/api/src/api.ts#L90-L100`).

### Merge Strategy: Squash and Conventional Commit Title

- **Squash merge only:** Keep `main` linear with one self-contained commit per pull request (`CONTRIBUTING.md#L81`).
- **Conventional Commit format:** Format the squash commit title according to [`CONTRIBUTING.md`](../CONTRIBUTING.md#L86-L96):
  - Scoped to a workspace package: `feat(core): ...`, `fix(api): ...`, `feat(web): ...`, `test(api): ...`
  - Repository-wide changes take no scope: `docs: ...`, `build: ...`, `chore: ...`
- **Issue linkage:** Include `Closes #<issue>` in the commit body so the linked issue closes automatically when merged.

---

## 3. Release Checklist

Currently, Concord tracks the latest commit on `main` (`SECURITY.md#L45`), and deployments build from `main` or the [`Dockerfile`](../Dockerfile). When cutting a milestone or tagged release:

1. **Clean working tree on `main`:**
   ```sh
   git checkout main && git pull --ff-only
   pnpm install --frozen-lockfile
   pnpm build && pnpm typecheck && pnpm test
   pnpm e2e
   ```
2. **Audit schema migrations:** If `ORG_MIGRATIONS` or `CONTROL_MIGRATIONS` in [`services/api/src/schema.ts`](../services/api/src/schema.ts) grew since the previous release:
   - Verify [`docs/schema.md`](./schema.md) matches every table and column.
   - Verify [`docs/upgrading.md`](./upgrading.md) accurately describes any operational impact, and remind operators to run `pnpm concord backup <dir>` before upgrading (`docs/upgrading.md#L55-L67`).
3. **Verify container build and smoke check:**
   ```sh
   docker build -t concord:release-check .
   ```
   Confirm the container starts cleanly against an existing data directory and responds `{"ok":true}` on `GET /api/health` (`services/api/src/api.ts#L81-L84`).
4. **Version and tag (when publishing a tagged release):**
   - Update `"version"` in [`package.json`](../package.json), [`packages/core/package.json`](../packages/core/package.json), [`services/api/package.json`](../services/api/package.json), and [`apps/web/package.json`](../apps/web/package.json).
   - Update [`SECURITY.md`](../SECURITY.md#L43-L45) if the supported-versions policy changes.
   - Create an annotated tag (`git tag -a vX.Y.Z -m "vX.Y.Z"`) and push the tag to the repository.

---

## 4. Handling Security and Code of Conduct Reports

### Security Reports

Vulnerability reports arrive via **GitHub Private Vulnerability Reporting** (`Security → Report a vulnerability`, documented in [`SECURITY.md`](../SECURITY.md#L8-L17)):

1. **Acknowledge within 5 working days:** Confirm receipt in the private advisory thread.
2. **Assess and communicate plan within 10 working days:** Check the report against the in-scope areas in [`SECURITY.md`](../SECURITY.md#L19-L25) (cross-workspace data leaks in `services/api/src/tenants.ts`, auth/session bypasses in `services/api/src/auth.ts` and `auth-api.ts`, cookie/CSRF/origin checks and rate limiting in `services/api/src/security.ts`, path traversal in `services/api/src/main.ts`, or reconciliation calculation spoofing in `packages/core`).
3. **Develop the fix privately:** Use the GitHub security advisory's temporary private fork—do not open a public issue or public pull request before the patch is ready.
4. **Include a regression test:** Add a test in `services/api/test/tenancy.test.ts`, `service.test.ts`, or `packages/core/test/core.test.ts` that reproduces the exploit and fails without the fix.
5. **Coordinate disclosure:** Merge the fix to `main` and publish the security advisory once operators have a patched commit to deploy.

### Code of Conduct Reports

Conduct reports arrive via GitHub's "Report content" feature or via a private security advisory marked as a conduct report ([`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md#L28-L35)):

1. **Keep the reporter confidential:** Never share the reporter's identity without explicit consent.
2. **Conflict of interest:** If a report involves a maintainer, that maintainer must recuse themselves from viewing, discussing, or acting on the report.
3. **Enforcement actions:** Depending on severity, maintainers may edit or redact comments (especially leaked holder data), close or lock threads, issue a private warning, or block repeat offenders from the repository (`CODE_OF_CONDUCT.md#L30-L31`).

---

## 5. Dependency Update Handling

Concord deliberately keeps a small dependency footprint:

- **Pinned package manager:** `package.json` pins `pnpm@10.22.0` in `"packageManager"` (`package.json#L5`) and requires `node >= 24` (`package.json#L6-L8`) for built-in `node:sqlite`. Bumping `pnpm` requires updating `package.json` and regenerating `pnpm-lock.yaml` so `pnpm install --frozen-lockfile` succeeds in CI and [`Dockerfile`](../Dockerfile#L9).
- **`packages/core` stays zero-dependency at runtime:** [`packages/core/package.json`](../packages/core/package.json) has only `devDependencies` (`typescript`, `vitest`). Reject any change that adds runtime dependencies to `@concord/core`.
- **Evaluating updates in `services/api` and `apps/web`:**
  - `@stellar/stellar-sdk` (`services/api/package.json`): When upgrading, run `pnpm test` including [`services/api/test/decode-golden.test.ts`](../services/api/test/decode-golden.test.ts) to ensure XDR and CAP-67 event decoding in `services/api/src/chain.ts` remain bit-for-bit compatible with recorded mainnet/testnet fixtures.
  - `hono` and `@hono/node-server`: Verify session cookie handling, headers, and rate-limiting middleware in `services/api/test/tenancy.test.ts`.
  - `react`, `vite`, `@playwright/test`, and `@axe-core/playwright`: Run `pnpm build`, `pnpm --filter @concord/web test:a11y`, and `pnpm e2e` to confirm the production bundle and browser tests pass.
- **Lockfile discipline:** Every dependency change must update [`pnpm-lock.yaml`](../pnpm-lock.yaml) in the same commit.
