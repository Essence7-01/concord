# Security policy

Concord stores account credentials, session records and uploaded registers that list who holds
what. We take reports about it seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting instead: on the repository page,
go to **Security → Report a vulnerability**. Include:

- what is affected and which version or commit,
- steps or a proof of concept that reproduces it,
- what an attacker could do with it.

We aim to acknowledge a report within five working days and to tell you what we plan to do
within ten. This is a small project, so those are targets, not guarantees. Please give us a
reasonable chance to fix a problem before you disclose it.

## In scope

- Reading or changing another workspace's data (workspaces are meant to be isolated).
- Bypassing sign-in, session, invitation, reset-link or sign-up-code checks.
- Weaknesses in password storage, cookies, CSRF or origin checks, or rate limiting.
- Injection, path traversal or unsafe file handling in the API, the CLI or the static server.
- Reconciliation results that can be made to show the wrong figures through crafted input.

## Out of scope

- Denial of service by sheer volume. Concord is one process on one disk, and the README says so.
- Findings that need access to the server's disk or environment variables.
- Missing hardening on a deployment that ignores the README, such as serving over plain http.
- Problems in Stellar, its RPC providers or other third-party services.

## Things operators should know

- Concord sends no email. Invitations and password resets are links the operator hands over, so
  treat them as secrets.
- Set `CONCORD_PUBLIC_URL` to the https address people use, and `CONCORD_TRUST_PROXY` only to the
  number of reverse proxies you actually run. A wrong value lets clients spoof their IP for rate
  limiting.
- Back up the data directory (`pnpm concord backup`). It holds every account and workspace.

## Supported versions

Only the latest commit on `main` is supported. There are no tagged releases yet.
