# Security Policy

Concord stores account credentials, session records and uploaded registers that list who holds
what. We take reports about security vulnerabilities seriously and appreciate the contributions of
the security research community.

## Reporting a Vulnerability

### Primary Channel (GitHub Advisory)
If you have a GitHub account, please report security vulnerabilities using GitHub's private vulnerability
reporting:
1. Navigate to the Concord repository page on GitHub.
2. Go to **Security → Report a vulnerability**.
3. Provide details including:
   - What component is affected and which commit/version.
   - Detailed step-by-step reproduction instructions or a minimal proof of concept.
   - The impact and what an attacker could achieve.

### Fallback Channel (Email)
If you do not have a GitHub account or cannot access GitHub's private vulnerability reporting, you can
submit reports directly via email to:
- **`security@useconcord.org`**

Please encrypt sensitive details or request a public PGP key before transmitting exploitable payloads.
Include the same reproduction details as requested above.

---

## Response & Disclosure Timeline

We adhere to a standard **90-day coordinated disclosure timeline**:

1. **Initial Acknowledgment:** We aim to acknowledge receipt of your vulnerability report within
   **5 business days**.
2. **Triaging & Assessment:** Within **10 business days**, we will review the submission, reproduce the
   finding, assess severity, and provide an initial response with next steps or remediation plans.
3. **Regular Updates:** We will provide progress updates at least once every **14 calendar days** while
   a patch is being developed and validated.
4. **Remediation & Patching:** We work to develop and test patches as rapidly as possible, targeting
   completion within **90 calendar days** from initial report acknowledgment.
5. **Public Disclosure:** Public release of the patch and advisory will be coordinated jointly between
   maintainers and the reporter. If a critical zero-day is being actively exploited in the wild, we may
   accelerate disclosure and patching to protect users.

---

## Safe Harbour

We consider security research conducted under this policy to be:
- **Authorized** under applicable anti-hacking laws (including the Computer Fraud and Abuse Act (CFAA)
  and equivalent legislation).
- **Exempt** from anti-circumvention claims under the DMCA and similar legal frameworks.
- **Lawful**, helpful to the overall safety of the internet, and conducted in good faith.

If you conduct your research in good faith in accordance with this policy:
- We will not pursue civil action or initiate legal complaints against you regarding your research.
- If third parties pursue legal action against you for research conducted following this policy, we
  will state that your research was authorized by us.
- You must make a good-faith effort to avoid privacy violations, destruction of data, and interruption
  or degradation of services.
- You must not access, modify, or retain customer or holder data. If you inadvertently encounter
  sensitive personal or financial data, stop and contact us immediately without copying or sharing it.

---

## Scope

### In Scope
- Reading or changing another workspace's data (workspaces are meant to be isolated).
- Bypassing sign-in, session, invitation, reset-link, or sign-up-code checks.
- Weaknesses in password storage, cookies, CSRF, origin checks, or rate limiting.
- Injection, path traversal, or unsafe file handling in the API, the CLI, or the static server.
- Reconciliation results that can be made to show the wrong figures through crafted input.

### Out of Scope
- Denial of service by sheer volume. Concord is one process on one disk, and the documentation says so.
- Findings that require local access to the server's disk or direct modification of environment variables.
- Missing hardening on deployments that ignore documentation (such as serving over unencrypted plain HTTP).
- Vulnerabilities in upstream Stellar network nodes, public Horizon/Soroban RPC providers, or external infrastructure.
- Social engineering attacks against operators or contributors.

---

## Operational Security Guidelines

- Concord sends no email. Invitations and password resets are links the operator hands over, so
  treat them as secrets.
- Set `CONCORD_PUBLIC_URL` to the HTTPS address people use, and configure `CONCORD_TRUST_PROXY` only
  to the number of reverse proxies you actually run. A wrong value allows clients to spoof IP addresses
  and bypass rate limits.
- Back up the data directory regularly (`pnpm concord backup`). It holds every account, workspace, and
  audit record.

---

## Supported Versions

| Version / Branch | Supported | Notes |
| :--- | :---: | :--- |
| `main` (HEAD) | Yes | Currently supported; continuously patched. |
| Tagged releases | Planned | Once semver releases are tagged, the current and immediate previous minor release will receive security patches. |
| Historical commits | No | Untagged historical commits prior to `main` HEAD are not supported. |
