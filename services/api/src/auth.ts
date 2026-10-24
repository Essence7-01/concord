import type { Db } from "./db.js";
import {
  DEFAULT_COST,
  PASSWORD_MAX,
  PASSWORD_MIN,
  hashPassword,
  newId,
  newToken,
  sha256,
  verifyPassword,
  type ScryptCost,
} from "./security.js";

export class Unauthorized extends Error {}
export class Forbidden extends Error {}
export class Conflict extends Error {}
/** A request that is well-formed but cannot be honoured as asked. */
export class Rejected extends Error {}

export type Role = "owner" | "member";

export interface SessionInfo {
  /** Identifies the session row; the cookie holds the token it was hashed from. */
  idHash: string;
  user: { id: string; email: string; name: string };
  org: { id: string; name: string };
  role: Role;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

const DAY = 86_400_000;
const SESSION_LIFE_MS = 30 * DAY;
const SESSION_IDLE_MS = 7 * DAY;
const INVITE_LIFE_MS = 7 * DAY;
const RESET_LIFE_MS = DAY;
const SEEN_EVERY_MS = 10 * 60_000;

const WRONG = "Wrong email or password.";

function cleanEmail(input: unknown): string {
  const email = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Rejected("Enter a valid email address.");
  return email;
}

function cleanName(input: unknown, what: string, max = 80): string {
  const name = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > max) throw new Rejected(`${what} is required, up to ${max} characters.`);
  return name;
}

function checkPassword(input: unknown, email?: string): string {
  if (typeof input !== "string" || input.length < PASSWORD_MIN || input.length > PASSWORD_MAX) {
    throw new Rejected(`A password needs at least ${PASSWORD_MIN} characters.`);
  }
  if (email && input.toLowerCase() === email) throw new Rejected("Choose a password that is not your email address.");
  return input;
}

/** Accounts, workspaces, memberships and sessions. Knows nothing about assets. */
export class Auth {
  private readonly cost: ScryptCost;
  private readonly now: () => number;
  /** Burned on sign-in attempts for unknown emails, so timing does not reveal who has an account. */
  private dummy: Promise<string> | undefined;

  constructor(
    private readonly db: Db,
    private readonly options: { signup: "open" | "code"; cost?: ScryptCost; now?: () => number },
  ) {
    this.cost = options.cost ?? DEFAULT_COST;
    this.now = options.now ?? (() => Date.now());
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  // ── accounts ──────────────────────────────────────────────────────────────

  private createOrg(name: string): string {
    const id = newId();
    this.db.insert("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)", id, name, this.iso());
    return id;
  }

  private createUser(email: string, name: string, verified: boolean): string {
    const id = newId();
    this.db.insert(
      "INSERT INTO users (id, email, name, email_verified, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      email,
      name,
      verified ? 1 : 0,
      this.iso(),
    );
    return id;
  }

  private join(orgId: string, userId: string, role: Role): void {
    this.db.insert(
      "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      orgId,
      userId,
      role,
      this.iso(),
    );
  }

  private setCredential(userId: string, kind: "password" | "google", subject: string | null, secret: string | null): void {
    this.db.insert(
      "INSERT OR REPLACE INTO credentials (user_id, kind, subject, secret, updated_at) VALUES (?, ?, ?, ?, ?)",
      userId,
      kind,
      subject,
      secret,
      this.iso(),
    );
  }

  private userByEmail(email: string) {
    return this.db.get<{ id: string; email: string; name: string }>("SELECT id, email, name FROM users WHERE email = ?", email);
  }

  /** Spend a sign-up code when workspaces are by invitation of the operator. */
  private spendSignupCode(code: unknown): void {
    if (this.options.signup === "open") return;
    const hash = sha256(typeof code === "string" ? code.trim() : "");
    const spent = this.db.write(
      "UPDATE one_time_tokens SET used_at = ? WHERE token_hash = ? AND purpose = 'signup' AND used_at IS NULL AND expires_at > ?",
      this.iso(),
      hash,
      this.iso(),
    );
    if (spent === 0) throw new Forbidden("New workspaces need a sign-up code from the operator.");
  }

  /** A new account with a new workspace it owns. */
  async signUp(input: { email: unknown; name: unknown; password: unknown; orgName: unknown; code?: unknown }) {
    const email = cleanEmail(input.email);
    const name = cleanName(input.name, "Your name");
    const orgName = cleanName(input.orgName, "A workspace name");
    const password = checkPassword(input.password, email);
    if (this.userByEmail(email)) throw new Conflict("An account with this email already exists. Sign in instead.");
    // Hashing is slow and asynchronous; do it before the transaction opens.
    const secret = await hashPassword(password, this.cost);
    return this.db.tx(() => {
      if (this.userByEmail(email)) throw new Conflict("An account with this email already exists. Sign in instead.");
      this.spendSignupCode(input.code);
      const userId = this.createUser(email, name, false);
      this.setCredential(userId, "password", null, secret);
      const orgId = this.createOrg(orgName);
      this.join(orgId, userId, "owner");
      return { userId, orgId };
    });
  }

  async signIn(emailInput: unknown, passwordInput: unknown): Promise<{ userId: string; orgId: string }> {
    const email = typeof emailInput === "string" ? emailInput.trim().toLowerCase() : "";
    const password = typeof passwordInput === "string" ? passwordInput.slice(0, PASSWORD_MAX) : "";
    const user = this.userByEmail(email);
    const credential = user
      ? this.db.get<{ secret: string | null }>("SELECT secret FROM credentials WHERE user_id = ? AND kind = 'password'", user.id)
      : undefined;
    if (!user || !credential?.secret) {
      this.dummy ??= hashPassword("not a real password", this.cost);
      await verifyPassword(password, await this.dummy);
      throw new Unauthorized(WRONG);
    }
    if (!(await verifyPassword(password, credential.secret))) throw new Unauthorized(WRONG);
    return { userId: user.id, orgId: this.homeOrg(user.id) };
  }

  /** The workspace a user lands in: the one they last used, else the first they joined. */
  private homeOrg(userId: string): string {
    const row = this.db.get<{ org_id: string }>(
      `SELECT m.org_id FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.user_id = ? ORDER BY (m.org_id = u.last_org_id) DESC, m.created_at LIMIT 1`,
      userId,
    );
    if (!row) throw new Forbidden("This account does not belong to a workspace.");
    return row.org_id;
  }

  async changePassword(session: SessionInfo, current: unknown, next: unknown): Promise<void> {
    const stored = this.db.get<{ secret: string | null }>(
      "SELECT secret FROM credentials WHERE user_id = ? AND kind = 'password'",
      session.user.id,
    );
    // An account that only ever used Google sets its first password without a current one.
    if (stored?.secret && !(await verifyPassword(typeof current === "string" ? current : "", stored.secret))) {
      throw new Rejected("The current password is not right.");
    }
    const secret = await hashPassword(checkPassword(next, session.user.email), this.cost);
    this.db.tx(() => {
      this.setCredential(session.user.id, "password", null, secret);
      this.db.write("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?", session.user.id, session.idHash);
    });
  }

  hasPassword(userId: string): boolean {
    return Boolean(this.db.get("SELECT 1 AS x FROM credentials WHERE user_id = ? AND kind = 'password' AND secret IS NOT NULL", userId));
  }

  hasGoogle(userId: string): boolean {
    return Boolean(this.db.get("SELECT 1 AS x FROM credentials WHERE user_id = ? AND kind = 'google'", userId));
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  /** Returns the token to put in the cookie. Only its hash is stored. */
  startSession(userId: string, orgId: string): string {
    const token = newToken();
    this.db.tx(() => {
      this.db.insert(
        "INSERT INTO sessions (id_hash, user_id, org_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        sha256(token),
        userId,
        orgId,
        this.iso(),
        this.iso(),
        this.iso(SESSION_LIFE_MS),
      );
      this.db.write("UPDATE users SET last_org_id = ? WHERE id = ?", orgId, userId);
    });
    return token;
  }

  session(token: string | undefined): SessionInfo | undefined {
    if (!token) return undefined;
    const idHash = sha256(token);
    const row = this.db.get<{
      user_id: string;
      email: string;
      user_name: string;
      org_id: string;
      org_name: string;
      role: Role;
      last_seen_at: string;
      expires_at: string;
    }>(
      `SELECT s.user_id, u.email, u.name AS user_name, s.org_id, o.name AS org_name, m.role, s.last_seen_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN orgs o ON o.id = s.org_id
       JOIN memberships m ON m.org_id = s.org_id AND m.user_id = s.user_id
       WHERE s.id_hash = ?`,
      idHash,
    );
    if (!row) return undefined;
    const at = this.now();
    const seen = Date.parse(row.last_seen_at);
    if (Date.parse(row.expires_at) <= at || seen + SESSION_IDLE_MS <= at) {
      this.db.write("DELETE FROM sessions WHERE id_hash = ?", idHash);
      return undefined;
    }
    if (seen + SEEN_EVERY_MS <= at) this.db.write("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?", this.iso(), idHash);
    return {
      idHash,
      user: { id: row.user_id, email: row.email, name: row.user_name },
      org: { id: row.org_id, name: row.org_name },
      role: row.role,
    };
  }

  endSession(token: string | undefined): void {
    if (token) this.db.write("DELETE FROM sessions WHERE id_hash = ?", sha256(token));
  }

  /** Point a session at another workspace its user belongs to. */
  switchOrg(session: SessionInfo, orgId: unknown): void {
    const member = this.db.get(
      "SELECT 1 AS x FROM memberships WHERE org_id = ? AND user_id = ?",
      typeof orgId === "string" ? orgId : "",
      session.user.id,
    );
    if (!member) throw new Forbidden("You are not a member of that workspace.");
    this.db.tx(() => {
      this.db.write("UPDATE sessions SET org_id = ? WHERE id_hash = ?", String(orgId), session.idHash);
      this.db.write("UPDATE users SET last_org_id = ? WHERE id = ?", String(orgId), session.user.id);
    });
  }

  orgsOf(userId: string): Array<{ id: string; name: string; role: Role }> {
    return this.db.all<{ id: string; name: string; role: Role }>(
      "SELECT o.id, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY m.created_at",
      userId,
    );
  }

  // ── workspace and team ────────────────────────────────────────────────────

  orgExists(orgId: string): boolean {
    return Boolean(this.db.get("SELECT 1 AS x FROM orgs WHERE id = ?", orgId));
  }

  orgIds(): string[] {
    return this.db.all<{ id: string }>("SELECT id FROM orgs ORDER BY created_at").map((r) => r.id);
  }

  listOrgs() {
    return this.db.all<{ id: string; name: string; created_at: string; members: number }>(
      `SELECT o.id, o.name, o.created_at, (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members
       FROM orgs o ORDER BY o.created_at`,
    );
  }

  /** By id, or by exact name when only one workspace has it. For the operator's CLI. */
  findOrg(ref: string): { id: string; name: string } {
    const byId = this.db.get<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = ?", ref);
    if (byId) return byId;
    const byName = this.db.all<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE name = ? LIMIT 2", ref);
    if (byName.length > 1) throw new Rejected(`more than one workspace is called "${ref}"; use its id`);
    if (!byName[0]) throw new Rejected(`no workspace "${ref}"`);
    return byName[0];
  }

  renameOrg(orgId: string, name: unknown): void {
    this.db.write("UPDATE orgs SET name = ? WHERE id = ?", cleanName(name, "A workspace name"), orgId);
  }

  members(orgId: string) {
    return this.db
      .all<{ id: string; email: string; name: string; role: Role; created_at: string }>(
        `SELECT u.id, u.email, u.name, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = ? ORDER BY m.created_at`,
        orgId,
      )
      .map((m) => ({ id: m.id, email: m.email, name: m.name, role: m.role, joinedAt: m.created_at }));
  }

  private owners(orgId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'", orgId)!.n;
  }

  /** Accounts exist to belong to a workspace; one left with none is removed. */
  private dropStranded(): void {
    this.db.write("DELETE FROM users WHERE id NOT IN (SELECT user_id FROM memberships)");
  }

  removeMember(orgId: string, userId: string): void {
    this.db.tx(() => {
      const member = this.db.get<{ role: Role }>("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?", orgId, userId);
      if (!member) throw new Rejected("That person is not in this workspace.");
      if (member.role === "owner" && this.owners(orgId) === 1) {
        throw new Rejected("A workspace needs an owner. Make someone else an owner first, or delete the workspace.");
      }
      this.db.write("DELETE FROM memberships WHERE org_id = ? AND user_id = ?", orgId, userId);
      this.dropStranded();
    });
  }

  setRole(orgId: string, userId: string, role: unknown): void {
    if (role !== "owner" && role !== "member") throw new Rejected("Role must be owner or member.");
    this.db.tx(() => {
      const member = this.db.get<{ role: Role }>("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?", orgId, userId);
      if (!member) throw new Rejected("That person is not in this workspace.");
      if (member.role === "owner" && role === "member" && this.owners(orgId) === 1) {
        throw new Rejected("A workspace needs an owner.");
      }
      this.db.write("UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?", role, orgId, userId);
    });
  }

  /** Removes the workspace's identity records. The caller deletes its database file. */
  deleteOrg(orgId: string): void {
    this.db.tx(() => {
      this.db.write("DELETE FROM orgs WHERE id = ?", orgId);
      this.dropStranded();
    });
  }

  // ── invitations ───────────────────────────────────────────────────────────

  /** Returns the link token once. It is not recoverable afterwards. */
  createInvite(session: SessionInfo, emailInput: unknown, roleInput: unknown) {
    const email = cleanEmail(emailInput);
    const role: Role = roleInput === "owner" ? "owner" : "member";
    const existing = this.userByEmail(email);
    if (existing && this.db.get("SELECT 1 AS x FROM memberships WHERE org_id = ? AND user_id = ?", session.org.id, existing.id)) {
      throw new Rejected("That person is already in this workspace.");
    }
    const token = newToken();
    const id = newId();
    this.db.tx(() => {
      // A fresh link for the same address replaces the one still pending.
      this.db.write("DELETE FROM invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL", session.org.id, email);
      this.db.insert(
        "INSERT INTO invites (id, token_hash, org_id, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        sha256(token),
        session.org.id,
        email,
        role,
        session.user.id,
        this.iso(),
        this.iso(INVITE_LIFE_MS),
      );
    });
    return { id, token, email, role, expiresAt: this.iso(INVITE_LIFE_MS) };
  }

  invites(orgId: string) {
    return this.db
      .all<{ id: string; email: string; role: Role; created_at: string; expires_at: string }>(
        "SELECT id, email, role, created_at, expires_at FROM invites WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at",
        orgId,
        this.iso(),
      )
      .map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at }));
  }

  revokeInvite(orgId: string, inviteId: string): void {
    this.db.write("DELETE FROM invites WHERE id = ? AND org_id = ? AND accepted_at IS NULL", inviteId, orgId);
  }

  private pendingInvite(token: unknown) {
    return this.db.get<{ id: string; org_id: string; org_name: string; email: string; role: Role }>(
      `SELECT i.id, i.org_id, o.name AS org_name, i.email, i.role FROM invites i JOIN orgs o ON o.id = i.org_id
       WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?`,
      sha256(typeof token === "string" ? token : ""),
      this.iso(),
    );
  }

  lookupInvite(token: unknown) {
    const invite = this.pendingInvite(token);
    if (!invite) return undefined;
    return { org: invite.org_name, email: invite.email, role: invite.role, hasAccount: Boolean(this.userByEmail(invite.email)) };
  }

  /**
   * Join the workspace an invitation names. Someone new sets a name and password. Someone who
   * already has an account must be signed in as that account: a link alone never adds a
   * password to, or opens, an existing account.
   */
  async acceptInvite(
    token: unknown,
    as: { session?: SessionInfo | undefined; name?: unknown; password?: unknown },
  ): Promise<{ userId: string; orgId: string }> {
    const invite = this.pendingInvite(token);
    if (!invite) throw new Rejected("This invitation is no longer valid. Ask for a new one.");
    const existing = this.userByEmail(invite.email);
    if (existing) {
      if (as.session?.user.id !== existing.id) {
        throw new Unauthorized(`Sign in as ${invite.email} to accept this invitation.`);
      }
      this.db.tx(() => this.admit(invite, existing.id));
      return { userId: existing.id, orgId: invite.org_id };
    }
    const name = cleanName(as.name, "Your name");
    const secret = await hashPassword(checkPassword(as.password, invite.email), this.cost);
    const userId = this.db.tx(() => {
      if (this.userByEmail(invite.email)) throw new Conflict("An account with this email already exists. Sign in instead.");
      const id = this.createUser(invite.email, name, false);
      this.setCredential(id, "password", null, secret);
      this.admit(invite, id);
      return id;
    });
    return { userId, orgId: invite.org_id };
  }

  /** Spend the invitation and add the member. Call inside a transaction. */
  private admit(invite: { id: string; org_id: string; role: Role }, userId: string): void {
    const spent = this.db.write("UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL", this.iso(), invite.id);
    if (spent === 0) throw new Rejected("This invitation is no longer valid. Ask for a new one.");
    this.db.write(
      "INSERT OR IGNORE INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      invite.org_id,
      userId,
      invite.role,
      this.iso(),
    );
  }

  // ── Google ────────────────────────────────────────────────────────────────

  /**
   * Sign in with a Google identity, creating the account on first use. An email that already
   * has a password account is refused rather than merged: nobody proved they own that address
   * when the password account was made, so merging would hand it to whoever got there first.
   */
  googleSignIn(profile: GoogleProfile, context: { invite?: string; code?: string } = {}): { userId: string; orgId: string } {
    if (!profile.emailVerified) throw new Forbidden("Google has not verified this email address.");
    const email = cleanEmail(profile.email);
    const linked = this.db.get<{ user_id: string }>(
      "SELECT user_id FROM credentials WHERE kind = 'google' AND subject = ?",
      profile.sub,
    );
    const invite = context.invite ? this.pendingInvite(context.invite) : undefined;
    const invited = invite && invite.email.toLowerCase() === email ? invite : undefined;
    if (linked) {
      if (invited) {
        this.db.tx(() => this.admit(invited, linked.user_id));
        return { userId: linked.user_id, orgId: invited.org_id };
      }
      return { userId: linked.user_id, orgId: this.homeOrg(linked.user_id) };
    }
    if (this.userByEmail(email)) {
      throw new Conflict("An account with this email already exists. Sign in with its password, then connect Google under Settings.");
    }
    const name = cleanName(profile.name || email.split("@")[0], "Your name");
    return this.db.tx(() => {
      if (!invited) this.spendSignupCode(context.code);
      const userId = this.createUser(email, name, true);
      this.setCredential(userId, "google", profile.sub, null);
      if (invited) {
        this.admit(invited, userId);
        return { userId, orgId: invited.org_id };
      }
      const orgId = this.createOrg(`${name.split(" ")[0]}'s workspace`);
      this.join(orgId, userId, "owner");
      return { userId, orgId };
    });
  }

  /** Attach a Google identity to the account that is signed in. */
  linkGoogle(userId: string, profile: GoogleProfile): void {
    const user = this.db.get<{ email: string }>("SELECT email FROM users WHERE id = ?", userId);
    if (!user) throw new Unauthorized("Sign in first.");
    if (!profile.emailVerified || profile.email.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw new Rejected(`Connect the Google account for ${user.email}.`);
    }
    const taken = this.db.get<{ user_id: string }>("SELECT user_id FROM credentials WHERE kind = 'google' AND subject = ?", profile.sub);
    if (taken && taken.user_id !== userId) throw new Conflict("That Google account is connected to another account.");
    this.db.tx(() => {
      this.setCredential(userId, "google", profile.sub, null);
      this.db.write("UPDATE users SET email_verified = 1 WHERE id = ?", userId);
    });
  }

  // ── operator ──────────────────────────────────────────────────────────────

  createSignupCode(note?: string, lifeMs = 14 * DAY): string {
    const code = newToken(12);
    this.db.insert(
      "INSERT INTO one_time_tokens (token_hash, purpose, note, created_at, expires_at) VALUES (?, 'signup', ?, ?, ?)",
      sha256(code),
      note ?? null,
      this.iso(),
      this.iso(lifeMs),
    );
    return code;
  }

  /** A one-day token that lets its holder set a new password. Only the operator can make one. */
  createResetToken(emailInput: string): string {
    const user = this.userByEmail(emailInput.trim().toLowerCase());
    if (!user) throw new Rejected(`no account for ${emailInput}`);
    const token = newToken();
    this.db.insert(
      "INSERT INTO one_time_tokens (token_hash, purpose, user_id, created_at, expires_at) VALUES (?, 'reset', ?, ?, ?)",
      sha256(token),
      user.id,
      this.iso(),
      this.iso(RESET_LIFE_MS),
    );
    return token;
  }

  async resetPassword(token: unknown, password: unknown): Promise<{ userId: string; orgId: string }> {
    const hash = sha256(typeof token === "string" ? token : "");
    const find = () =>
      this.db.get<{ user_id: string; email: string }>(
        `SELECT t.user_id, u.email FROM one_time_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ? AND t.purpose = 'reset' AND t.used_at IS NULL AND t.expires_at > ?`,
        hash,
        this.iso(),
      );
    const row = find();
    if (!row) throw new Rejected("This reset link is no longer valid.");
    const secret = await hashPassword(checkPassword(password, row.email), this.cost);
    this.db.tx(() => {
      if (!find()) throw new Rejected("This reset link is no longer valid.");
      this.db.write("UPDATE one_time_tokens SET used_at = ? WHERE token_hash = ?", this.iso(), hash);
      this.setCredential(row.user_id, "password", null, secret);
      this.db.write("DELETE FROM sessions WHERE user_id = ?", row.user_id);
    });
    return { userId: row.user_id, orgId: this.homeOrg(row.user_id) };
  }
}
