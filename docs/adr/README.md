# Architecture Decision Records (ADRs)

This directory holds the Architecture Decision Records (ADRs) for this repository. An ADR is a short, immutable document that captures a significant technical decision, the context around it, and its consequences. ADRs explain *why* the code is the way it is, so contributors do not have to reverse-engineer the reasoning from the source.

## Index

ADRs are numbered sequentially and never reused or renumbered. Add a row to this table when you add a new ADR.

| ADR | Title | Status | Date |
| --- | ----- | ------ | ---- |
| [ADR-0001](./0001-sqlite-per-tenant.md) | One SQLite database per workspace | Accepted | 2026-10-18 |
| [ADR-0002](./0002-bigint-amounts.md) | Amounts are `bigint` in the smallest unit and parsing never rounds | Accepted | 2026-10-18 |
| [ADR-0003](./0003-no-email.md) | Concord sends no email | Accepted | 2026-10-18 |
| [ADR-0004](./0004-read-only.md) | Read-only by design: no keys, no transactions | Accepted | 2026-10-18 |
| [ADR-0005](./0005-hash-routing-same-origin.md) | Hash routing and same-origin dashboard architecture | Accepted | - |

The next ADR you add should use the next unused number. Check the directory and open pull requests before choosing a number, and add the corresponding row above.

## When an ADR is required

Write an ADR when a change introduces or alters any of the following:

- **Schema changes.** Any modification to persisted or wire-format schemas, including migrations, field additions/removals, required/optional flag changes, and changes to serialization formats.
- **New dependency classes.** Adding a dependency that belongs to a class not already in use (for example, a new runtime, database driver, caching layer, or cryptography library). This includes adding a new top-level dependency that changes the dependency surface of the project.
- **Security-relevant behaviour.** Any change to authentication, authorization, secret handling, input validation boundaries, cryptography, or data exposure.

If you are unsure whether a change requires an ADR, open it as a question in the pull request description and ask a maintainer before merging.

## Statuses

The table below lists the statuses used by this process. ADR records should use one of these statuses; check the existing ADRs' `Status:` lines for the exact spelling in use.

| Status | Meaning |
| ------ | ------- |
| Proposed | Under discussion. Not yet binding. Code may exist in a draft branch but must not rely on the decision as settled. |
| Accepted | Agreed and binding. The codebase should reflect this decision. |
| Superseded | Replaced by a later ADR. Keep the record for history and link to the replacing ADR. |

This list is not exhaustive: other statuses (for example, `Rejected` or `Deprecated`) may appear in existing ADR. If you introduce a new status, use it consistently and consider adding it to this table.

ADRs are immutable once accepted. To change a decision, write a new ADR that supersedes the old one, and update the old ADR's status to `Superseded by ADR-00XX`.

## Template (MADR)

Copy this template into a new file named `docs/adr/0001-short-title.md`, replacing the number and title. The format follows [MADR](https://adr.github.io/madr/).

```markdown
# ADR-0001: Short title

* Status: Proposed
* Date: YYYY-MM-DD
* Deciders: Names or roles of the people who made the decision
* Consulted: Names or roles of people consulted, and the topics

## Context and Problem Statement
Describe the forces at play, the problem to solve, and any constraints. Reference relevant files and lines where useful.

## Considered Options

* Option A
  * Description
  * Pros:
  * Cons:
* Option B
  * Description
  * Pros:
  * Cons:

## Decision and Rationale
State the chosen option and why. If the decision is proposed, say what would make it accepted.

## Consequences

* Positive:
* Negative:
* Neutral:

## Links

* Related ADRs
* Relevant source files and issues
```

## How to add an ADR

1. Create `docs/adr/000N-short-title.md` using the template above. Use the next unused number.
2. Set the status to `Proposed` while it is under discussion.
3. Add a row to the index table at the top of this file.
4. Once agreed, set the status to `Accepted` and merge it in the same pull request as the code change it describes.
5. If a later decision replaces it, mark this ADE as `Superseded by ADR-00XX` and link the new ADR.

## Notes

- ADRs must not contain holder data, real user data, secrets, or credentials. Use placeholders only where necessary and keep them generic.
- Keep ADRs short and focused on one decision each.
- Link to source files by path rather than copying code into the ADR, so the record stays valid as the code evolves.
