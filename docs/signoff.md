# Sign-Off Semantics: Keys, Fingerprints, Stale Notes and Reopening

This document is for analysts and auditors who acknowledge or resolve breaks in Concord. It explains
what a sign-off is attached to, what makes it survive the next reconciliation, and when it stops
counting. Nothing here needs the dashboard: the same rules apply to the HTTP API and to the audit
export.

Every statement below is checked against the code at the paths named in it.

---

## 1. What a sign-off is attached to

A sign-off is a row in the `break_notes` table, and it is keyed by **three** things — the asset, the
note scope, and the break's stable `key`
([`services/api/src/schema.ts`](../services/api/src/schema.ts), table `break_notes`):

```text
PRIMARY KEY (asset_id, scope, key)
```

The consequence is important: a note belongs to a **break identity**, not to a reconciliation run and
not to a row position in a table. Concord re-derives breaks on every run, and a break keeps its note
across register uploads as long as the asset, the scope and the `key` are unchanged.

Because the table is written with `INSERT OR REPLACE` on that primary key
([`services/api/src/concord.ts`](../services/api/src/concord.ts), `setNote`), there is exactly **one
note per break**: a later sign-off replaces the earlier text and author for that key. The API route
that writes it is `PUT /assets/:id/notes`, and it takes only `scope`, `key`, `fingerprint`, `status`
and `note` from the caller
([`services/api/src/api.ts`](../services/api/src/api.ts)).

### Scopes

`scope` decides which reconciliation the break came from
([`services/api/src/concord.ts`](../services/api/src/concord.ts), `annotate`):

| Scope | Breaks it covers | Where the breaks are produced |
| --- | --- | --- |
| `recon` | Position breaks and journal movement breaks from register/movement reconciliation | `reconcile()` |
| `controls` | Issuer-control breaks: uninstructed freezes, clawbacks and authorisations, and unexecuted instructions | `controlsLog()` |
| `action:<id>` | Distribution breaks for one corporate action (dividend, split, redemption) | `reconcileAction()` |

Any other scope is rejected: `setNote` accepts `recon`, `controls`, or `action:<id>` where `<id>` is a
corporate action of the asset being signed ([`services/api/src/concord.ts`](../services/api/src/concord.ts)).

### Keys

The `key` is the stable identifier of the break kind and subject. It is what makes ageing work — the
same discrepancy on the next run produces the same key, so the note follows it. The formats are:

- Position breaks ([`packages/core/src/reconcile.ts`](../packages/core/src/reconcile.ts)):
  - `UNMAPPED_HOLDER:<holderId>`
  - `MISSING_IN_REGISTER:<address>`
  - `MISSING_ON_CHAIN:<address>`
  - `QUANTITY_MISMATCH:<address>`
  - `STATUS_MISMATCH:<address>`
  - `SUPPLY_MISMATCH` (no suffix — there is one supply comparison per asset)
  - `INCOMPLETE_HISTORY:<address>`
- Distribution breaks ([`packages/core/src/distributions.ts`](../packages/core/src/distributions.ts)):
  `<status>:<address>`, so one entry per evaluated recipient.
- Control breaks ([`packages/core/src/controls.ts`](../packages/core/src/controls.ts)):
  - `UNINSTRUCTED_CONTROL:<eventId>`
  - `UNEXECUTED_INSTRUCTION:<instructionRef>`

A note written against one address therefore never suppresses a different address's break, and an
`action:<id>` note never applies to another action.

---

## 2. What the fingerprint captures

The `key` says *which* break this is. The `fingerprint` says *which numbers* the analyst was looking
at. Concord stores it beside the note and compares it on every read. The values are built when breaks
are shaped ([`services/api/src/concord.ts`](../services/api/src/concord.ts)):

| Scope | Fingerprint | Meaning |
| --- | --- | --- |
| `recon` — position breaks | `${chainUnits}\|${registerUnits}` | The on-chain units and the register units, as raw base units, rendered as text. A change to either side changes the fingerprint. |
| `recon` — movement breaks | `${chainUnits}\|${registerUnits}` | The same pair, for a movement/journalled difference. |
| `action:<id>` — distributions | `${expected}\|${observed}` | The expected distribution and what the chain shows for that recipient. |
| `controls` | the break's own `key` | Control breaks are keyed by the offending event or instruction, so the identity of the break is the fingerprint. |

Two practical consequences:

- An empty side is represented by an empty string, so `"1000|"` (on-chain only) and `"|1000"`
  (register only) are different sign-offs, and neither matches `"1000|1000"`.
- For `controls`, the fingerprint is the key itself. A control note is tied to that specific event or
  instruction; if the offending event changes, the key changes too and the earlier note no longer
  applies.

The fingerprint is **not** a hash of the file, the run or the break text. It changes exactly when the
compared figures change.

---

## 3. Statuses and what the analyst writes

`status` is one of `open`, `acknowledged` or `resolved`; anything else is rejected
([`services/api/src/concord.ts`](../services/api/src/concord.ts), `setNote`).

- `acknowledged` — the discrepancy is real but understood and expected for now, for example a pending
  transfer or a settlement still in flight. A **non-empty note is required**.
- `resolved` — the discrepancy is corrected or the adjustment is complete. A **non-empty note is
  required**.
- `open` — withdraw a sign-off and put the break back in the working queue. A note is optional here.

The requirement is enforced server-side: `a note is required to sign off a break` is returned for
`acknowledged` or `resolved` with blank text. The dashboard enforces the same rule before it sends
anything ([`apps/web/src/breaks.tsx`](../apps/web/src/breaks.tsx), `SignOff`), because the note is
what an auditor reads beside the decision.

### Note length limit

A note is limited to **4,000 characters**:

- `setNote` rejects a longer note with `note is too long`
  ([`services/api/src/concord.ts`](../services/api/src/concord.ts)).
- The dashboard textarea sets `maxLength={4000}`
  ([`apps/web/src/breaks.tsx`](../apps/web/src/breaks.tsx)).

The `key` and `fingerprint` are each limited to 500 characters and must be text
([`services/api/src/concord.ts`](../services/api/src/concord.ts)).

---

## 4. Authorship comes from the session

Who signed is never taken from the request. `setNote` receives an `Actor` resolved by the caller, and
`PUT /assets/:id/notes` deliberately copies only `fingerprint`, `status` and `note` from the body —
the route comment says it plainly: *"Who signed is the session's user."*
([`services/api/src/api.ts`](../services/api/src/api.ts)).

The actor is built in one place
([`services/api/src/api.ts`](../services/api/src/api.ts)):

```text
label = `${session.user.name} <${session.user.email}>`
```

so a signed-in sign-off records the person's name and email as `author`, with the user id in
`author_id`. Local operator commands use `cli:<unix-user>` instead
([`services/api/src/cli.ts`](../services/api/src/cli.ts)). A caller cannot claim to be someone else by
adding an author field, and the dashboard says who it will sign as before you submit
([`apps/web/src/breaks.tsx`](../apps/web/src/breaks.tsx)).

The author, the timestamp and the note are carried into the audit pack: the breaks CSV includes
`status`, `note` and `noteAuthor`
([`services/api/src/concord.ts`](../services/api/src/concord.ts), `exportPack`).

---

## 5. When a break reopens and the note goes stale

Every time breaks are read, `annotate` looks up the stored note for `(asset, scope, key)` and compares
its fingerprint with the fingerprint of the break as it is now
([`services/api/src/concord.ts`](../services/api/src/concord.ts), `annotate`):

```text
current    = stored.fingerprint === break.fingerprint
status     = current ? stored.status : "open"
noteStale  = stored note exists && !current
```

So the rule is: **a sign-off holds only while the figures it was written against are unchanged.**

If the discrepancy widens, narrows, or appears on the other side, the fingerprint no longer matches
and:

- the break's effective status reverts to `open` on its own — no one has to reopen it manually;
- `noteStale` is `true`, and the dashboard shows *"The figures changed after the last sign-off, so
  this break reopened. The earlier note is kept below."*
  ([`apps/web/src/breaks.tsx`](../apps/web/src/breaks.tsx));
- the earlier note is **not** deleted. `annotate` returns the stored `note`, `noteAuthor` and
  `noteAt` regardless, so an auditor still sees who signed off on which figures, and what the figures
  became afterwards.

This is deliberate: a partial or shifting break can never be quietly masked by a sign-off written
against different numbers. To sign off again, the analyst reviews the new figures and writes a new
note, which replaces the old row for that key.

Withdrawn sign-offs (`status: open`) behave the same way — the note row remains, so the audit trail
shows the withdrawal and its author.

---

## 6. Checklist before signing off

1. Confirm the scope matches what you are looking at: `recon` for positions and movements,
   `controls` for issuer control events, `action:<id>` for one corporate action.
2. Read the current figures — they are the fingerprint. If they change after you sign, the break
   reopens and your note is marked stale.
3. For `acknowledged` or `resolved`, write what an auditor needs: the cause, the expectation, and any
   reference to the off-chain correction. Keep it under 4,000 characters.
4. Remember the note is signed as the session user, appears in the audit export, and is the only note
   kept for that break.
