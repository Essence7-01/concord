# ADR 0005: Hash Routing and Same-Origin Dashboard Architecture

## Status

Accepted

## Context

Concord is a single-process application combining a background indexer, an HTTP API, and a React-based single-page web dashboard ([`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#L3-L17)). The web client ([`apps/web`](../../apps/web)) allows operators and auditors to inspect reconciliations, watch regulated Stellar assets, upload books, and sign off discrepancies.

When designing the web client, session authentication, and invitation workflows, two fundamental architectural choices were made:
1. Routing uses client-side URI fragments (`#/` hash routing) rather than HTML5 History API path-based routing.
2. In production, the API and the web application are served strictly from the same origin, with `SameSite=Strict` session cookies and no Cross-Origin Resource Sharing (CORS).

This document explains the rationale behind these decisions, how they protect sensitive tokens, how same-origin security is enforced, and the architectural trade-offs involved.

---

## Decision

### 1. Hash-Based Client Routing (`#/`)

The web dashboard uses hash-based client routing powered by the browser's native `hashchange` event ([`apps/web/src/App.tsx#L49-L66`]):

```typescript
function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const [path = "", search = ""] = hash.replace(/^#/, "").split("?");
  const [, scope, first, second] = path.split("/");
  // Parses routes: #/a/:assetId/:tab, #/invite/:token, #/reset/:token, #/settings, etc.
```

The application defines distinct hash routes:
- `#/` — Workspace overview and asset list ([`apps/web/src/Overview.tsx`](../../apps/web/src/Overview.tsx)).
- `#/a/:assetId/:tab` — Asset view across tabs: `reconciliation`, `holdings`, `actions`, `controls`, `events`, `export` ([`apps/web/src/App.tsx#L31-L39,L59-L61`]).
- `#/settings` — Workspace settings, team management, and invitations ([`apps/web/src/Settings.tsx`](../../apps/web/src/Settings.tsx)).
- `#/signin` and `#/signup` — User authentication ([`apps/web/src/Auth.tsx`](../../apps/web/src/Auth.tsx)).
- `#/invite/:token` — Workspace invitation acceptance ([`apps/web/src/Auth.tsx#L224-L311`]).
- `#/reset/:token` — One-time password reset form ([`apps/web/src/Auth.tsx#L332-L351`]).

#### Why Hash Routing?
Under RFC 3986 (§3.5), URI fragment identifiers (`#...`) are interpreted solely by the user agent (browser) and are **never transmitted across the wire** in HTTP request lines. When a user navigates to `https://concord.example.com/#/a/ASSET_ID/reconciliation`, the browser requests only `GET / HTTP/1.1` from the server.

This provides two key benefits:
1. **Simplified Server Hosting:** The server only needs to serve the static application shell (`index.html`) at root. In `services/api/src/main.ts#L100-L122`, a single fallback route serves `index.html` for non-file requests. Hash routing ensures that client routing works reliably across diverse deployment environments (such as static previews, subpath deployments, or lightweight proxies) without requiring intricate server-side URL rewrite configurations.
2. **Leakage Prevention for Sensitive Tokens:** Sensitive credentials embedded in links remain on the client side and never touch server access logs.

---

### 2. Keeping Invitation and Reset Tokens Out of Server Logs

Concord deliberately sends no automated emails ([`README.md`](../../README.md#L42-L45,L146-L147)). Workspace owners generate invitation links and share them directly ([`apps/web/src/Settings.tsx#L80-L135`]), and administrators generate password reset links via the CLI ([`services/api/src/cli.ts#L121-L124`]).

These links contain high-entropy, secret one-time tokens:
- **Invitation links:** `${options.publicUrl}/#/invite/${token}` ([`services/api/src/api.ts#L140`]).
- **Password reset links:** `${config.publicUrl}/#/reset/${token}` ([`services/api/src/cli.ts#L122`]).

#### Protection Against Log Exposure
If tokens were passed as standard URL path segments (e.g. `/invite/TOKEN`) or query parameters (e.g. `/?token=TOKEN`), every request to fetch the initial page would transmit the raw secret in the HTTP request line. Consequently, the plaintext secret token would be logged by:
- Upstream reverse proxies (Nginx, Caddy, HAProxy, Envoy).
- Cloud ingress controllers, load balancers, and CDN access logs (e.g. AWS ALB, Cloudflare, Render access logs).
- The Concord Node process HTTP logging facilities.
- Browser `Referer` headers if external resources were loaded.

Because Concord places tokens after the hash (`/#/invite/${token}` and `/#/reset/${token}`):
1. **Zero Wire Transmission on Initial Page Fetch:** When the recipient clicks the link, the browser makes a clean request for `GET /` or `GET /index.html`. The token is not sent over the network to the static file server.
2. **Explicit POST Body Submission:** Once the client-side JavaScript runs in the browser, `App.tsx` parses the token from `location.hash` and passes it to the `Invite` or `Reset` components ([`apps/web/src/Auth.tsx#L224-L351`]). The client then sends the token to the API inside a JSON request body via an encrypted POST request over TLS:
   - Invitation lookup: `POST /api/auth/invites/lookup` with `{ token }` ([`services/api/src/auth-api.ts#L198-L204`]).
   - Invitation acceptance: `POST /api/auth/invites/accept` with `{ token, name, password }` ([`services/api/src/auth-api.ts#L206-L216`]).
   - Password reset: `POST /api/auth/reset` with `{ token, password }` ([`services/api/src/auth-api.ts#L218-L223`]).
   HTTP bodies are not recorded in standard web access logs.
3. **Immediate Hash Scrubbing:** As soon as the password is reset or an invitation is accepted, the client clears the fragment by setting `location.hash = "#/"` ([`apps/web/src/Auth.tsx#L230,L338`]; [`apps/web/src/App.tsx#L331`]). This removes the spent token from the browser's address bar and local navigation history.
4. **Hashed Persistence:** On the database side, raw tokens are never written to disk; only their SHA-256 digests are stored in `control.db` (`token_hash` in `services/api/src/schema.ts#L188,L199`; [`services/api/src/auth.ts#L395,L426,L558,L572`]).

---

### 3. SameSite=Strict Session Cookies

Session authentication uses HTTP cookies rather than `localStorage` or `Bearer` authorization headers ([`services/api/src/auth-api.ts#L60-L87`]):

```typescript
export function sessions(auth: Auth, options: ApiOptions) {
  const secure = options.publicUrl.startsWith("https://");
  const name = secure ? "__Host-concord_session" : "concord_session";
  return {
    start(c: Context, userId: string, orgId: string): SessionInfo | undefined {
      const token = auth.startSession(userId, orgId);
      setCookie(c, name, token, {
        path: "/",
        httpOnly: true,
        secure,
        sameSite: "Strict",
        maxAge: 30 * 86_400,
      });
      return auth.session(token);
    },
    // ...
  };
}
```

#### Key Cookie Attributes
- **`SameSite=Strict`:** The browser will not send the session cookie on any cross-site request. Even if a user clicks an external link pointing to Concord from another website, email client, or messaging app, the cookie is withheld on the initial navigation. This provides robust protection against Cross-Site Request Forgery (CSRF). Because the application shell is loaded on the same origin and all API requests are dispatched via same-origin `fetch` ([`apps/web/src/api.ts#L33-L47`]), `SameSite=Strict` introduces no friction to normal application use.
- **`HttpOnly`:** Client-side JavaScript cannot read `document.cookie`, protecting the session token from extraction via cross-site scripting (XSS).
- **`__Host-` Prefix:** When HTTPS is active, the cookie name is prefixed with `__Host-` (`__Host-concord_session`). As specified in RFC 6265bis, `__Host-` cookies must have the `Secure` attribute, must be set from a secure origin, must use `path="/"`, and cannot be overwritten or shadowed by sibling subdomains (domain-locking).
- **Defense-in-Depth Origin Verification:** In addition to `SameSite=Strict`, Concord enforces origin verification on all state-changing API endpoints (`POST`, `PUT`, `PATCH`, `DELETE`) in `services/api/src/api.ts#L66-L75`:
  ```typescript
  const site = c.req.header("sec-fetch-site");
  const sameOrigin = site ? site === "same-origin" : c.req.header("origin") === options.publicUrl;
  if (!sameOrigin) return c.json({ error: "This request did not come from the Concord dashboard." }, 403);
  ```
- **OAuth Exception (`SameSite=Lax`):** For Google sign-in, the browser must navigate to Google and be redirected back to `/api/auth/google/callback` via a top-level cross-site redirect. Because `SameSite=Strict` cookies are omitted on cross-site navigations, the temporary OAuth state cookie (`__Host-concord_oauth`) is explicitly configured with `sameSite: "Lax"` and a 10-minute lifetime ([`services/api/src/auth-api.ts#L242-L249`]). Once authentication succeeds, the issued session cookie reverts to `SameSite=Strict` ([`services/api/src/auth-api.ts#L327`]).

---

### 4. Same-Origin Serving and No CORS

In production, the Concord Hono server serves both the HTTP API routes and the compiled static dashboard assets from the same process and origin ([`services/api/src/main.ts#L85-L122`]):

```typescript
// services/api/src/main.ts
app.route("/", createApi(...));

// Static files and SPA fallback
app.get("*", (c) => {
  // ... serves webDir assets or falls back to index.html
});
```

Because the frontend and backend share an identical origin (`CONCORD_PUBLIC_URL`):
- **No CORS Headers Needed:** Concord does not mount CORS middleware, nor does it respond with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, or `Access-Control-Allow-Headers`.
- **No Preflight Latency:** Browsers do not need to issue preflight `OPTIONS` requests before API requests. The client sends API requests with `credentials: "same-origin"` ([`apps/web/src/api.ts#L39,L51`]), reducing round-trip latency.
- **Zero Cross-Origin Attack Surface:** Since cross-origin requests are rejected by origin validation (`services/api/src/api.ts#L74`), external sites cannot query the API using ambient user credentials.

---

### 5. Trade-offs for Deep Links

While hash-based routing and same-origin architecture provide strong security and operational simplicity, they introduce architectural trade-offs:

#### Advantages
1. **Reliable In-App Deep Linking:** Operators can bookmark and share URLs pointing directly to specific assets and tabs, such as `#/a/:assetId/reconciliation` or `#/a/:assetId/controls`. The router correctly extracts `assetId` and active `tab` on initial load ([`apps/web/src/App.tsx#L57-L62`]).
2. **Network Switcher Synchronization:** When a user navigates to a deep link for an asset configured on a different network (e.g. Testnet vs. Mainnet), the dashboard automatically aligns the active network context to match the asset ([`apps/web/src/App.tsx#L334-L338`]).
3. **No 404s on Page Refresh:** Since the browser requests `/` from the server, page reloads on any sub-route never trigger server-side 404 errors, eliminating the need for server-side rewrite engines.
4. **Browser History Support:** Native `hashchange` listeners ensure standard forward and back browser navigation works as expected.

#### Limitations and Trade-offs
1. **Server Invisibility:** Because the server never sees the URI fragment, it cannot inspect deep link paths on incoming requests. This means:
   - **No Server-Side Rendering (SSR):** Content cannot be rendered ahead of time on the server based on the route. (This is acceptable for Concord, which is an interactive, private operational tool rather than a public content site).
   - **No Dynamic Social/OpenGraph Meta Tags:** Link previews cannot display asset-specific titles or descriptions.
   - **No HTTP-Level Status Codes for Missing Resources:** If an operator opens a deep link for an asset ID that does not exist (`#/a/non-existent-id/reconciliation`), the server returns HTTP 200 with `index.html`. The 404 state must be detected and displayed by the client-side UI after the API responds ([`apps/web/src/App.tsx#L425-L433`]).
2. **Query String Placement:** Query parameters must be placed within or after the hash fragment (e.g. `#/signin?error=google_failed`), as parsed by `hash.replace(/^#/, "").split("?")` in `apps/web/src/App.tsx#L56`. Query parameters placed before the hash (e.g. `/?error=google_failed#/signin`) are not automatically ingested by the client router's `search` parser.
3. **OAuth Redirect Boundary:** OAuth 2.0 / OpenID Connect redirect flows cannot directly navigate to a hash fragment from the identity provider. Google redirects to `/api/auth/google/callback`. To transition back into the client-side hash router, the backend server must handle the callback and issue an HTTP 302 redirect with the destination hash appended: `c.redirect(`${options.publicUrl}/#${hash}`, 302)` ([`services/api/src/auth-api.ts#L227,L328`]).
