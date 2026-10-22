# Good-First-Issue Guide & Labelling Scheme

This guide helps new contributors find approachable tasks and helps maintainers triage and label incoming issues consistently.

---

## 1. Issue Labelling Scheme

Concord uses an orthogonal labelling scheme combining **Difficulty**, **Functional Area**, and **Issue Type**.

### Difficulty Tiers

| Label | Description | Criteria |
|---|---|---|
| `good first issue` | Good for newcomers | Self-contained tasks requiring changes in only 1–2 files. Clear acceptance criteria, minimal ambiguity, and no breaking architectural changes. Ideal for first contributions. |
| `intermediate` | Needs codebase familiarity | Tasks touching multiple layers (e.g. extending a parser, adding an API route, or modifying multi-file flows). Requires understanding Concord's data models and test fixtures. |
| `advanced` | Cross-layer / design judgement | Complex tasks involving indexer replay semantics, database migrations across tenant stores, concurrency, or protocol-level integration. |

### Functional Areas (`area:*`)

| Label | Scope | Key Technologies |
|---|---|---|
| `area: core` | `packages/core` | Pure TypeScript, exact `bigint` accounting, zero I/O, event replay, reconciliation algorithms |
| `area: api` | `services/api` | Node.js, Hono, SQLite (`node:sqlite`), Stellar SDK, RPC event ingestion, CLI commands |
| `area: web` | `apps/web` | React 19, Vite, Tailwind CSS 4, accessible UI components, dashboard views |
| `area: docs` | `docs/`, `README.md` | Markdown documentation, architecture guides, operator runbooks |
| `area: infra` | Repo root, CI, Docker | GitHub Actions (`.github/workflows`), `Dockerfile`, deployment templates |

### Issue Types & Triage Tags

- `bug`: Something isn't working as intended.
- `documentation`: Additions or clarifications to technical documentation.
- `enhancement`: New feature or requested capability.
- `tests`: Test coverage expansion, new test cases, or fuzzing.
- `accessibility`: Accessibility barriers affecting assistive technology or WCAG conformance.
- `unconfirmed`: Bug reported from code inspection without a reproducing test case.

---

## 2. What Makes a "Good First Issue"

An issue qualifies for the `good first issue` label if it meets all of the following criteria:
1. **Clear Scope:** The exact files to touch and expected outcome are stated in the issue description.
2. **Minimal Dependencies:** The contributor does not need access to live private networks, private keys, or external paid RPCs (testnet or mock fixtures are sufficient).
3. **No Unresolved Design Decisions:** The architecture or interface has already been agreed upon by maintainers.
4. **Reproducible Locally:** The change can be verified entirely with `pnpm test` or local dev servers.

---

## 3. How to Claim an Issue

To prevent duplicate effort and ensure smooth collaboration:
1. **Comment on the Issue:** Leave a brief comment stating that you would like to work on it (e.g., *"I'd like to work on this issue."*).
2. **Wait for Assignment:** A maintainer will assign the issue to you or confirm it is available. Please only work on issues you are actively assigned to.
3. **One Issue at a Time:** Contributors are encouraged to focus on one open issue at a time until a PR is submitted and reviewed.
4. **Link in the Pull Request:** Always include `Closes #<issue-number>` in your pull request description so the issue closes automatically upon merge.

---

## 4. Expected Response Times & Inactivity Policy

- **Triage & Questions:** Maintainers aim to review incoming claims, questions, and PRs within **2 to 3 business days**.
- **Inactivity Window:** If an issue is assigned to a contributor and no pull request or progress update is posted within **7 calendar days**, the issue may be unassigned and returned to the contributor pool for others to take on.

---

## 5. Area Map: Where to Start Reading

When picking up an issue in a specific area, start with these core files:

```
packages/core/
  src/index.ts            # Public export surface
  src/reconcile.ts        # Position reconciliation & break definitions
  src/holdings.ts         # Ledger event replay & balance derivations
  test/fixtures.ts        # Event builder ev() and unit scaler u()
  test/core.test.ts       # Test suite patterns and examples

services/api/
  src/concord.ts          # Core service orchestrating sync, books, and reconciliations
  src/api.ts              # Hono REST API route definitions
  src/chain.ts            # Stellar RPC getEvents ingestion and Horizon opening balances
  src/schema.ts           # SQLite database schema and migrations
  test/helpers.ts         # In-memory test harness and mock chain sources

apps/web/
  src/App.tsx             # Root layout, routing, asset navigation
  src/tabs/Reconcile.tsx  # Main reconciliation breakdown view
  src/ui.tsx              # Reusable design system primitives (Button, Badge, Select)
  src/api.ts              # Frontend HTTP client talking to services/api

docs/
  ARCHITECTURE.md         # Three-package mental model and flow diagram
  breaks.md               # Complete break-type glossary and sign-off lifecycle
```
