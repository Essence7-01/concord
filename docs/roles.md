# Roles and Permissions Matrix

Concord workspaces use a two-tier role model: **Owner** and **Member**. 

Workspaces are isolated SQLite databases (`data/orgs/<orgId>.db`), while user accounts, memberships, and sessions reside in the control database (`data/control.db`). Every user belongs to one or more workspaces with an explicit role defined in `memberships` (`services/api/src/schema.ts`).

---

## Capabilities by Role

| Action / Capability | Endpoint / Source Reference | Owner | Member | Notes |
| :--- | :--- | :---: | :---: | :--- |
| **Workspace Management** | | | | |
| View member list | `GET /api/org/members` (`services/api/src/api.ts`) | Yes | Yes | Members see user emails and roles; pending invites are only returned to owners. |
| Invite new user | `POST /api/org/invites` (`services/api/src/api.ts:135`) | **Yes** | No | Generates an invitation token link valid for 7 days. Role can be specified as `owner` or `member`. |
| Revoke invitation | `DELETE /api/org/invites/:inviteId` (`services/api/src/api.ts:142`) | **Yes** | No | Immediately expires the invitation token. |
| Change member role | `PATCH /api/org/members/:userId` (`services/api/src/api.ts:147`) | **Yes** | No | Promotes member to owner, or demotes owner to member (subject to last-owner guard). |
| Remove another member | `DELETE /api/org/members/:userId` (`services/api/src/api.ts:153`) | **Yes** | No | Evicts member from workspace; revokes their active sessions in that workspace. |
| Leave workspace | `DELETE /api/org/members/:userId` (`services/api/src/api.ts:156`) | Yes | Yes | Any user may leave a workspace voluntarily, provided they are not the sole remaining owner. |
| Rename workspace | `PATCH /api/org` (`services/api/src/api.ts:160`) | **Yes** | No | Updates the organisation name in `data/control.db`. |
| Delete workspace | `DELETE /api/org` (`services/api/src/api.ts:166`) | **Yes** | No | Requires exact confirmation match of workspace name. Erases database file and memberships. |
| **Asset Administration** | | | | |
| Watch asset | `POST /api/assets` (`services/api/src/api.ts:191`) | Yes | Yes | Initiates ledger background indexing and sets optional ignore addresses. |
| Update asset settings | `PATCH /api/assets/:id` (`services/api/src/api.ts:213`) | Yes | Yes | Updates display name and ignore address lists. |
| Trigger sync / rebuild | `POST /api/assets/:id/sync`, `/rebuild` (`services/api/src/api.ts:221`) | Yes | Yes | Throttled ledger sync and state re-computation. |
| Stop watching asset | `DELETE /api/assets/:id` (`services/api/src/api.ts:216`) | **Yes** | No | Drops the asset's indexed state and registers from the workspace database. |
| **Books & Registers** | | | | |
| Download CSV templates | `GET /api/templates/:kind` (`services/api/src/api.ts:244`) | Yes | Yes | Fetches header schemas for registers, journals, or instructions. |
| Import register CSV | `POST /api/assets/:id/registers` (`services/api/src/api.ts:254`) | Yes | Yes | Parses and stores official share register as-of snapshot; triggers reconciliation by default. |
| Delete imported register | `DELETE /api/assets/:id/registers/:id` (`services/api/src/api.ts:262`) | Yes | Yes | Deletes an uploaded register snapshot and its associated runs. |
| Import journal CSV | `POST /api/assets/:id/journal` (`services/api/src/api.ts:266`) | Yes | Yes | Ingests off-chain transactions for movement matching. |
| Import instructions CSV | `POST /api/assets/:id/instructions` (`services/api/src/api.ts:271`) | Yes | Yes | Ingests control instructions (`authorize`, `freeze`, `unfreeze`, `clawback`, with account, issued_at, optional units, approved_by, reason) that the controls log matches against on-chain actions. |
| **Reconciliation & Audit** | | | | |
| Run reconciliation | `POST /api/assets/:id/reconciliations` (`services/api/src/api.ts:280`) | Yes | Yes | Executes position and movement matching against ledger state as-of register date. |
| Sign off on breaks / notes | `PUT /api/assets/:id/notes` (`services/api/src/api.ts:295`) | Yes | Yes | Signs off on discrepancies; session user ID and timestamp are permanently recorded in audit trail. |
| Corporate actions | `POST /api/assets/:id/actions` (`services/api/src/api.ts:287`) | Yes | Yes | Models dividends or splits and reconciles entitlements. |
| Audit pack export | `GET /api/assets/:id/export` (`services/api/src/api.ts:305`) | Yes | Yes | Generates verifiable JSON audit package and CSV breakdowns. |

---

## Last-Owner Protection Rules

Concord enforces strict invariants to prevent orphaned workspaces (`services/api/src/auth.ts:338-366`):

1. **Minimum One Owner:** Every workspace must have at least one active owner at all times.
2. **Prevented Demotions:** An owner cannot demote their own or another user's role to `member` if there is only 1 owner remaining (`auth.ts:364`):
   ```
   "A workspace needs an owner."
   ```
3. **Prevented Removals & Self-Removal:** An owner cannot leave or be deleted from a workspace if they are the sole owner (`auth.ts:351`):
   ```
   "A workspace needs an owner. Make someone else an owner first, or delete the workspace."
   ```
4. **Orderly Dissolution:** To remove the last owner, the workspace must be deleted outright via `DELETE /api/org` with typed name confirmation.
