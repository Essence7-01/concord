# Security model

What Concord protects, where the trust boundaries sit, and which mechanisms enforce them.
Written for security reviewers and operators. Every claim is checked against the code; file
references point at the authoritative lines. For how to report a problem, see
[`SECURITY.md`](../SECURITY.md); for how the pieces fit together, see
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## What is being protected

- **Uploaded registers.** Who holds what: holder ids, units, accounts. This is the most
  sensitive data Concord stores, and it lives in the workspace databases.
- **Account credentials and sessions.** Emails, scrypt password hashes, session records,
  sign-up codes, invitation and password-reset tokens, all in the control database.
- **Reconciliation output.** Breaks, sign-off notes and audit exports derived from the above.

Concord never holds Stellar keys and never moves money. Chain data is read-only public input,
fetched outbound from RPC and Horizon.

## Trust boundaries

1. **Browser ↔ API.** The dashboard is a static page shell; every API call is a same-origin
   `fetch`. The boundary is enforced by the session cookie plus an origin check on each request
   (both below).
2. **Workspace ↔ workspace.** Each workspace is its own SQLite file, `orgs/<orgId>.db` under
   `CONCORD_DATA_DIR` (`services/api/src/tenants.ts`); accounts, sessions and invitations live
   separately in `control.db` (`services/api/src/config.ts`). A request is resolved to one
   workspace handle, so no query can cross database files.
3. **Server ↔ Stellar.** Outbound-only requests to RPC/Horizon. Chain responses are untrusted
   input to the indexer; nothing on-chain can call into Concord.
4. **Process ↔ host.** Anyone with the server's disk or environment variables is inside the
   boundary. `SECURITY.md` declares such findings out of scope; the section at the end of this
   document spells out what that access yields.

## Password storage

`services/api/src/security.ts`:

- scrypt with `N = 2^15, r = 8, p = 3` (the OWASP-recommended cost). The parameters travel in
  the stored hash (`scrypt$N$r$p$salt$key`), so the default can be raised later while old
  hashes still verify.
- Passwords are NFKC-normalised before hashing and must be 10–200 characters
  (`PASSWORD_MIN`/`PASSWORD_MAX`).
- At most two scrypt jobs run at once (`SLOTS = 2`); the rest queue. A burst of sign-in
  attempts therefore cannot starve Node's libuv thread pool for the rest of the process.
- Verification uses `timingSafeEqual`.

## Sessions and cookies

- A session token is 32 random bytes (`newToken`, `services/api/src/security.ts`). Only its
  SHA-256 is stored; the database never holds a usable token
  (`services/api/src/auth.ts`, `createSession`/`sessionByToken`).
- The session cookie is `__Host-concord_session` on https deployments: `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/` (`services/api/src/auth-api.ts`). The `__Host-` prefix stops a
  sibling subdomain planting a cookie of the same name. `Strict` is workable because the page
  shell is static and every API call is a same-origin fetch — no cross-site navigation ever
  needs to carry the session.
- The OAuth flow cookie `__Host-concord_oauth` is the one deliberate exception: `SameSite=Lax`,
  because it has to survive the navigation back from Google. It lives 10 minutes, is
  `HttpOnly`, and its payload (state, nonce, PKCE verifier) is HMAC-signed by `Signer`
  (`services/api/src/security.ts`), so a value planted from elsewhere is refused.

## Origin checks

Every workspace API request must arrive with `Sec-Fetch-Site: same-origin`; a browser that does
not send `Sec-Fetch-Site` must instead present an `Origin` header equal to the configured
`CONCORD_PUBLIC_URL`. Anything else is answered 403 (`services/api/src/api.ts`, `sameOrigin`).
Together with `SameSite=Strict` this gives two independent CSRF layers.

Response hardening on every page (`services/api/src/main.ts`): CSP with `default-src 'self'`,
`object-src 'none'`, `frame-ancestors 'none'`; `Strict-Transport-Security` for a year on https;
`Referrer-Policy: same-origin`.

## Rate limits

Fixed windows held in memory (`RateLimiter`, `services/api/src/security.ts`): one process
serves everything, so no shared store is needed. Expired windows are swept every 60 s; past
50,000 live keys the sweeper runs eagerly. Current values:

| Action | Keyed by | Limit |
|---|---|---|
| Sign-up | IP | 20 per 60 min |
| Sign-in attempts | IP | 20 per 10 min |
| Failed sign-ins | email | 10 per 15 min, cleared by a successful sign-in |
| Password change | user | 10 per 15 min |
| Invitation create/accept | IP | 20 per 10 min |
| Password reset | IP | 20 per 10 min |
| Google OAuth start/callback | IP | 30 per 10 min |
| Asset lookup | user | 30 per 60 s |
| Watch / unwatch asset | user | 20 per 10 min |
| Manual sync | user | 60 per 10 min |

Sources: `services/api/src/auth-api.ts` and `services/api/src/api.ts` (the `limit`/`throttle`
calls name each value). IP-keyed limits honour `CONCORD_TRUST_PROXY`
(`services/api/src/config.ts`): set it to exactly the number of reverse proxies you run, or
clients can spoof their IP for rate limiting — `SECURITY.md` repeats this warning.

## Google OAuth

Authorization-code flow with PKCE (`services/api/src/auth-api.ts`): a fresh random `state`,
`nonce` and verifier per attempt; the challenge is `S256` (SHA-256, base64url); the token
exchange sends the verifier. All three values ride in the signed, short-lived
`__Host-concord_oauth` cookie described above, so the callback can only complete in the browser
that started the flow.

## What an operator with disk access can do

Concord does not defend against its own host. Someone who can read `CONCORD_DATA_DIR` can:

- read every workspace database in full — registers, holder ids, balances, breaks, notes;
- read `control.db` — emails, scrypt password hashes, the SHA-256 hashes of session,
  invitation and reset tokens.

What they do **not** get from a copy of the files: passwords (scrypt at the cost above) or
usable session/invitation/reset tokens (only hashes are stored). Write access to the disk or
the environment is full compromise — rows can be inserted, the process restarted with a
different configuration — which is why `SECURITY.md` rules such findings out of scope and why
backups of the data directory deserve the same care as the live host.

## Non-goals

- **Denial of service by volume.** Concord is one process on one disk. The rate limits above
  bound abuse of expensive paths (scrypt, RPC syncs); they are not a DDoS defence.
- **Email.** Concord sends none. Invitation and password-reset links are shown to the operator
  to hand over out of band — treat them as secrets while they live.
- **Deployments that ignore the README.** On plain http the cookies drop `Secure` and the
  `__Host-` prefix and HSTS is off; run https behind a proxy and set `CONCORD_PUBLIC_URL`
  accordingly.

No holder names, addresses or balances in this document are real; none are invented either —
there are none.
