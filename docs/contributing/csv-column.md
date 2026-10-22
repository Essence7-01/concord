# Contributor Guide: Adding a CSV Column

Concord ingests three CSV formats from off-chain transfer-agent and custodian systems: the **register** (`register.ts`), the **transaction journal** (`movements.ts`), and **issuer-control instructions** (`controls.ts`). Adding a new required or optional column to any of these imports touches up to six layers across `@concord/core`, `@concord/api`, `@concord/web`, and documentation.

---

## Overview of Touch Points

| Kind | Parser & Type (`packages/core/src/`) | Template Constant | SQLite Table (`services/api/src/schema.ts`) | Service Import & Read (`services/api/src/concord.ts`) | Dashboard Hints (`apps/web/src/tabs/`) |
|---|---|---|---|---|---|
| **Register** | `register.ts` (`RegisterPosition`, `parseRegisterCsv`) | `REGISTER_COLUMNS` | `register_positions` | `importRegister`, `registerPositions` | `Reconciliation.tsx` |
| **Journal** | `movements.ts` (`JournalEntry`, `parseJournalCsv`) | `JOURNAL_COLUMNS` | `journal` | `importJournal`, `journal` | `Reconciliation.tsx` |
| **Instructions** | `controls.ts` (`Instruction`, `parseInstructionsCsv`) | `INSTRUCTION_COLUMNS` | `instructions` | `importInstructions`, `instructions` | `Controls.tsx` |

---

## Step 1: Update the Parser, Domain Interface, and Column Aliases (`packages/core`)

All three CSV importers call `parseCsvTable(text)` in [`packages/core/src/csv.ts`](../../packages/core/src/csv.ts#L50-L63), which normalizes every header name to lower-case and converts runs of spaces or hyphens into underscores (`h.trim().toLowerCase().replace(/[\s-]+/g, "_")`).

### 1a. Extend the TypeScript Interface
Add the new property to the parsed row interface:
- **Register:** `RegisterPosition` in [`packages/core/src/register.ts`](../../packages/core/src/register.ts#L7-L14).
- **Journal:** `JournalEntry` in [`packages/core/src/movements.ts`](../../packages/core/src/movements.ts#L11-L20).
- **Instructions:** `Instruction` in [`packages/core/src/controls.ts`](../../packages/core/src/controls.ts#L11-L21).

If the column carries a token quantity, type it as `bigint` and parse it with `parseUnits(raw, decimals)` from [`packages/core/src/amount.ts`](../../packages/core/src/amount.ts#L11-L24) so excess decimal precision is rejected rather than rounded.

### 1b. Register Header Aliases (When Applicable)
- **Register (`packages/core/src/register.ts#L26-L36`):** Add the canonical snake_case column name and any accepted transfer-agent header synonyms to the `ALIASES` map so `pick(table.headers, "<field>")` resolves them automatically.
- **Journal (`packages/core/src/movements.ts#L48-L78`):** Required headers are checked against `table.headers` at line 49; optional headers or aliases (such as `values.from_account ?? values.from` at line 66) are read from `values`.
- **Instructions (`packages/core/src/controls.ts#L29-L60`):** Required headers are checked at line 30; optional fields (such as `values.approved_by` and `values.reason` at lines 54–55) are read from `values`.

### 1c. Row Validation and Issue Reporting
Inside the `for (const { line, values } of table.records)` loop:
- Missing **required** headers throw before the row loop (`throw new Error("... CSV needs a <col> column")`), rejecting the whole file.
- Invalid or missing **per-row** values throw inside the `try { ... } catch (err)` block so the offending line number and reason are appended to `issues: ParseIssue[]` while valid rows still load.

---

## Step 2: Update the `*_COLUMNS` Template Constant

Each parser file exports the canonical ordered tuple of column names:

- `REGISTER_COLUMNS` in [`packages/core/src/register.ts`](../../packages/core/src/register.ts#L47)
- `JOURNAL_COLUMNS` in [`packages/core/src/movements.ts`](../../packages/core/src/movements.ts#L42)
- `INSTRUCTION_COLUMNS` in [`packages/core/src/controls.ts`](../../packages/core/src/controls.ts#L23)

[`services/api/src/api.ts`](../../services/api/src/api.ts#L5) imports these three constants into `TEMPLATES` (`api.ts#L19-L23`) to serve `GET /api/templates/:kind` (`register.csv`, `journal.csv`, `instructions.csv`), which the dashboard's `<TemplateLink kind="..." />` button downloads (`apps/web/src/ui.tsx#L303-L318`).

Add the new canonical column name to the appropriate `*_COLUMNS` array in the position where it should appear in downloaded blank templates, then run `pnpm --filter @concord/core build` so `@concord/api` and `@concord/web` see the updated export.

---

## Step 3: Add a Database Column and Migration (If Persisted)

If the parsed field must be stored in the workspace SQLite database:

1. **Append a new migration** to the end of `ORG_MIGRATIONS` in [`services/api/src/schema.ts`](../../services/api/src/schema.ts#L7):
   ```ts
   export const ORG_MIGRATIONS: readonly string[] = [
     // ... existing migrations (never edit a shipped entry) ...
     `ALTER TABLE register_positions ADD COLUMN nominee_code TEXT;`,
   ];
   ```
   Never edit the initial `CREATE TABLE` migration—`Db.migrate` in [`services/api/src/db.ts`](../../services/api/src/db.ts#L30-L57) tracks applied entries via `PRAGMA user_version`.
2. **Document the column** in [`docs/schema.md`](../schema.md) under the `register_positions`, `journal`, or `instructions` table section.

---

## Step 4: Wire Service Import, Read, and Export (`services/api`)

Update [`services/api/src/concord.ts`](../../services/api/src/concord.ts) so the column is written on import, reconstructed when reading back into `@concord/core`, and included in API/audit outputs where relevant:

1. **Import (`INSERT`) and Read (`SELECT`):**
   - **Register:** Update the `INSERT INTO register_positions` statement in `importRegister` (`concord.ts#L740-L748`) and map the column back onto `RegisterPosition` in `registerPositions` (`concord.ts#L782-L790`).
   - **Journal:** Update `INSERT OR REPLACE INTO journal` in `importJournal` (`concord.ts#L802-L813`) and map it back onto `JournalEntry` in `journal` (`concord.ts#L819-L832`).
   - **Instructions:** Update `INSERT OR REPLACE INTO instructions` in `importInstructions` (`concord.ts#L844-L855`) and map it back onto `Instruction` in `instructions` (`concord.ts#L861-L874`).
2. **Audit pack and API responses (if exposed):**
   - Check `controls()`, `reconcile()`, and `auditPack()` / `auditCsv()` in [`services/api/src/concord.ts`](../../services/api/src/concord.ts#L1335-L1480) if the new column should appear in JSON responses or exported audit CSV files.

---

## Step 5: Update Dashboard Hints and Tables (`apps/web`)

Update the user-facing column hints and tables in the web dashboard so operators know the column is accepted:

- **Register and Journal upload forms:** [`apps/web/src/tabs/Reconciliation.tsx`](../../apps/web/src/tabs/Reconciliation.tsx#L65-L115) lists expected columns next to `<TemplateLink kind="register" />` and `<TemplateLink kind="journal" />`.
- **Instructions upload form and controls table:** [`apps/web/src/tabs/Controls.tsx`](../../apps/web/src/tabs/Controls.tsx#L170-L220) lists expected columns next to `<TemplateLink kind="instructions" />` and renders instruction metadata on matched/unexecuted rows.
- **Client API types:** If the new field is returned by HTTP endpoints, add it to the corresponding response type in [`apps/web/src/api.ts`](../../apps/web/src/api.ts).

---

## Step 6: Update Tests and Documentation

1. **Core parser tests (`packages/core/test/core.test.ts`):**
   - Add a test verifying the canonical column name, any header aliases, and row-level validation failures (`issues`).
2. **Service and template tests (`services/api/test/service.test.ts`):**
   - Update the blank-template expectation (`GET /api/templates/register.csv` in `services/api/test/service.test.ts#L341`) if `REGISTER_COLUMNS`, `JOURNAL_COLUMNS`, or `INSTRUCTION_COLUMNS` changed.
   - Add an import round-trip test verifying the column persists in SQLite and survives reconciliation or audit export.
3. **Documentation:**
   - Update the **Input files** table in [`README.md`](../../README.md#L116-L127).
   - Update [`docs/user-guide.md`](../user-guide.md), [`docs/cli.md`](../cli.md), [`docs/schema.md`](../schema.md), and [`docs/audit-pack.md`](../audit-pack.md) if the column changes user workflows, schema tables, or audit exports.
4. **Verify everything builds and passes:**
   ```sh
   pnpm build && pnpm typecheck && pnpm test
   ```
