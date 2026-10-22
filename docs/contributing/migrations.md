# Contributor Guide: Adding a Database Migration Safely

Concord stores data in SQLite through Node's built-in `node:sqlite` module ([`services/api/src/db.ts`](../../services/api/src/db.ts)) and manages schema changes through ordered SQL migration arrays in [`services/api/src/schema.ts`](../../services/api/src/schema.ts). This guide explains how `Db.migrate` works, how to choose between the control and workspace migration lists, how to write both additive and table-rebuild migrations, and how to test a migration against pre-existing data.

---

## 1. The Append-Only Rule

Every SQLite database in Concord records how many migrations have been applied in its header via `PRAGMA user_version`:

- **Never edit or reorder a migration that has shipped.** Existing databases with `user_version >= N` will never re-run indices `0 .. N - 1`. Editing an existing entry causes new databases to have a different schema from upgraded databases.
- **Always append a new string** to the end of `ORG_MIGRATIONS` or `CONTROL_MIGRATIONS` in [`services/api/src/schema.ts`](../../services/api/src/schema.ts).
- **Update [`docs/schema.md`](../schema.md)** in the same pull request whenever tables, columns, check constraints, or indexes change.

---

## 2. Control vs. Workspace Migration Lists

Concord separates identity and session data from per-organisation reconciliation data ([`services/api/src/schema.ts`](../../services/api/src/schema.ts)):

| Migration List | Database File(s) | Opened By | Tables |
|---|---|---|---|
| `CONTROL_MIGRATIONS` (`schema.ts#L139`) | `data/control.db` | `AuthStore` (`services/api/src/auth.ts`) at server startup (`main.ts` `openRuntime`) | `users`, `credentials`, `orgs`, `memberships`, `sessions`, `invites`, `one_time_tokens` |
| `ORG_MIGRATIONS` (`schema.ts#L7`) | `data/orgs/<orgId>.db` (default for `new Db(path)`) | `TenantStore` (`services/api/src/tenants.ts`) lazily when a workspace is accessed | `meta`, `assets`, `events`, `openings`, `registers`, `register_positions`, `journal`, `instructions`, `runs`, `actions`, `break_notes` |

Because workspace databases are opened lazily when an organisation's routes or background sync run, a new entry in `ORG_MIGRATIONS` migrates each workspace file the first time that workspace is opened after an upgrade.

---

## 3. How `Db.migrate` Runs (`user_version` and `foreign_key_check`)

When `new Db(path, migrations)` is constructed ([`services/api/src/db.ts`](../../services/api/src/db.ts#L13-L57)), it configures WAL mode (`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`), runs `this.migrate(migrations)`, and then turns foreign-key enforcement on (`PRAGMA foreign_keys = ON;`).

Inside `Db.migrate` (`services/api/src/db.ts#L30-L57`):

1. **Read current version:** Queries `PRAGMA user_version` (`version`).
2. **Reject newer databases:** If `version > migrations.length`, `Db.migrate` throws:
   ```text
   <path> is at schema <version>; this build only knows <migrations.length>
   ```
   This prevents an older binary from corrupting a database migrated by a newer build.
3. **Reject unversioned legacy files:** If `version === 0` but `sqlite_master` already contains tables, `Db.migrate` throws:
   ```text
   <path> predates schema versioning and cannot be upgraded; move it aside
   ```
4. **Disable `foreign_keys` for the migration loop:** Executes `PRAGMA foreign_keys = OFF;` before applying pending migrations (`db.ts#L42`). In SQLite, `PRAGMA foreign_keys` must be changed outside a transaction, and keeping it off during DDL allows table rebuilds (`DROP TABLE` + `ALTER TABLE ... RENAME TO`) without triggering `ON DELETE CASCADE` on child tables.
5. **Run each pending migration in its own transaction:** For each index `i` from `version` to `migrations.length - 1`:
   - Executes `BEGIN`.
   - Runs `this.raw.exec(migrations[i]!)`.
   - Runs `PRAGMA foreign_key_check` (`db.ts#L47-L49`). If any row violates a foreign key constraint, `Db.migrate` throws `migration ${i + 1} leaves dangling references`, executes `ROLLBACK`, and aborts startup.
   - Sets `PRAGMA user_version = ${i + 1}` (which SQLite records atomically as part of the transaction) and executes `COMMIT`.
6. **Re-enable foreign keys:** Once `this.migrate(migrations)` returns, the constructor runs `PRAGMA foreign_keys = ON;` (`db.ts#L22`) so all runtime queries enforce referential integrity.

---

## 4. Writing Migrations

### Simple Additive Changes (`ALTER TABLE ... ADD COLUMN` / `CREATE TABLE`)

When adding a nullable column, a column with a `DEFAULT`, a new table, or a new index, append a single SQL string to the appropriate array in [`services/api/src/schema.ts`](../../services/api/src/schema.ts):

```ts
export const ORG_MIGRATIONS: readonly string[] = [
  // ... existing shipped migrations (do not edit) ...
  `
ALTER TABLE register_positions ADD COLUMN custodian_ref TEXT;
CREATE INDEX register_positions_custodian_ref ON register_positions (register_id, custodian_ref)
  WHERE custodian_ref IS NOT NULL;
`,
];
```

Rules for `ADD COLUMN`:
- Every existing row in the table will receive the column's `DEFAULT` (or `NULL` if nullable).
- If adding a `NOT NULL` column to a table that may already contain rows, you must provide a `DEFAULT` value, or perform a data-copy table rebuild.
- Remember that token amounts are always stored as `TEXT` (decimal or base-unit strings), never `REAL` or `FLOAT`.

### Data-Copy / Table-Rebuild Migrations

SQLite does not support modifying `CHECK` constraints, changing column types, or altering primary keys in place with `ALTER TABLE`. For example, if `assets.start_mode` or `instructions.type` needs a new allowed value in its `CHECK` constraint, use SQLite's table-rebuild pattern inside your migration entry:

```ts
  `
CREATE TABLE assets_new (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  code TEXT NOT NULL,
  issuer TEXT,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  start_mode TEXT NOT NULL CHECK (start_mode IN ('baseline', 'ledger', 'window')),
  state TEXT NOT NULL DEFAULT 'indexing' CHECK (state IN ('indexing', 'ready')),
  start_ledger INTEGER,
  baseline_ledger INTEGER,
  history_from TEXT,
  cursor TEXT,
  synced_ledger INTEGER,
  synced_at TEXT,
  sync_error TEXT,
  sync_error_at TEXT,
  ignore_addresses TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO assets_new (
  id, network, code, issuer, name, decimals, start_mode, state,
  start_ledger, baseline_ledger, history_from, cursor, synced_ledger,
  synced_at, sync_error, sync_error_at, ignore_addresses, created_by, created_at
)
SELECT
  id, network, code, issuer, name, decimals, start_mode, state,
  start_ledger, baseline_ledger, history_from, cursor, synced_ledger,
  synced_at, sync_error, sync_error_at, ignore_addresses, created_by, created_at
FROM assets;

DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;
`,
```

Why this is safe in `Db.migrate`:
- `PRAGMA foreign_keys = OFF` is already set before the transaction begins (`db.ts#L42`), so `DROP TABLE assets` does not trigger `ON DELETE CASCADE` on `events`, `openings`, `registers`, `runs`, or `actions`.
- Recreate any indexes or triggers that belonged to the dropped table before the migration finishes.
- Before committing, `Db.migrate` runs `PRAGMA foreign_key_check` (`db.ts#L47`). If any child row in `events` or `registers` no longer matches a primary key in the rebuilt `assets` table, the migration rolls back cleanly.

---

## 5. Testing a Migration Against a Fixture

Never rely only on fresh `:memory:` databases starting at the latest schema. Always write a test in `services/api/test/service.test.ts` or `services/api/test/tenancy.test.ts` that:

1. Creates a temporary SQLite database file migrated only up to the **previous** schema version (`ORG_MIGRATIONS.slice(0, -1)` or `CONTROL_MIGRATIONS.slice(0, -1)`).
2. Inserts representative parent and child rows using the old schema.
3. Closes the database and reopens the same file with the full migration list (`ORG_MIGRATIONS` or `CONTROL_MIGRATIONS`).
4. Asserts that `PRAGMA user_version` advanced, existing rows and child foreign-key relationships survived intact, and the new column or constraint behaves as expected.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { ORG_MIGRATIONS } from "../src/schema.js";

describe("schema migrations", () => {
  it("upgrades an existing workspace database through the latest migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-mig-"));
    const file = join(dir, "org.db");
    try {
      // 1. Open at migration 1 and seed representative rows.
      const before = new Db(file, ORG_MIGRATIONS.slice(0, 1));
      before.run(
        `INSERT INTO assets (id, network, code, name, decimals, start_mode, state, created_at)
         VALUES ('ASSET-1', 'testnet', 'FUND', 'Fund', 7, 'window', 'ready', '2026-10-01T00:00:00Z')`,
      );
      before.run(
        `INSERT INTO openings (asset_id, address, amount, as_of_ledger)
         VALUES ('ASSET-1', 'GABC2345672345672345672345672345672345672345672345672345', '10000000', 100)`,
      );
      before.close();

      // 2. Reopen with all migrations applied.
      const after = new Db(file, ORG_MIGRATIONS);
      const opening = after.get<{ amount: string }>(
        "SELECT amount FROM openings WHERE asset_id = 'ASSET-1'",
      );
      expect(opening?.amount).toBe("10000000");
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

 Also verify that `Db.migrate` rejects dangling foreign-key references by testing that a broken child row causes `new Db(file, [...ORG_MIGRATIONS, "DELETE FROM assets;"])` (with `foreign_keys = OFF`) to throw `leaves dangling references` and roll back.
