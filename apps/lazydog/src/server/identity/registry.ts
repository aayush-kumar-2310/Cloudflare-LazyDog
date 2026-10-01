import { DurableObject } from "cloudflare:workers";
import {
  createUserIdentityStore,
  identityKey,
  UserIdentityConflictError,
  type ChannelIdentity,
  type UserIdentity,
  type UserIdentityStore
} from "agents/channels";
import { toHex } from "@lazydog/shared";
import type { Profile, WebhookSourceSummary } from "../../shared/types";

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const LINK_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_LINK_ATTEMPTS = 5;
// No 0/O/1/I so codes survive being read aloud or retyped.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const webIdentity = (githubId: string): ChannelIdentity => ({
  channelKey: "web",
  scope: "github",
  subject: githubId
});

export type RedeemResult =
  | { ok: true; userId: string; login: string }
  | { ok: false; reason: "invalid" | "expired" | "rate-limited" | "already-linked" };

export type WebhookSourceSecret = WebhookSourceSummary & { userId: string; secret: string };

async function sha256Hex(text: string) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export const normalizeLinkCode = (code: string) =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");

/**
 * The one place that answers "which LazyDog user is this?".
 *
 * Every channel identity (GitHub account, Slack user, email sender) maps to a
 * LazyDog user id only through an explicit link recorded here; nothing is
 * inferred from display names or email-looking strings. The user id is also
 * the name of that user's LazyDog Durable Object.
 *
 * One global instance keeps the demo simple; it would be sharded by identity
 * key if identity lookups ever became a bottleneck (see docs/IDENTITY.md).
 */
export class IdentityRegistry extends DurableObject<Env> {
  private readonly store: UserIdentityStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = createUserIdentityStore(ctx.storage, {
      createUserId: () => `usr_${crypto.randomUUID().replace(/-/g, "")}`
    });
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ld_users (
        user_id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ld_link_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ld_link_attempts (
        identity_key TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ld_webhook_sources (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private login(userId: string): string {
    const row = this.ctx.storage.sql
      .exec<{ login: string }>("SELECT login FROM ld_users WHERE user_id = ?", userId)
      .toArray()[0];
    return row?.login ?? "unknown";
  }

  async loginWithGitHub(githubId: string, login: string): Promise<{ userId: string; login: string }> {
    const identity = webIdentity(githubId);
    let user = await this.store.findUser(identity);
    if (!user) {
      const userId = `usr_${crypto.randomUUID().replace(/-/g, "")}`;
      user = await this.store.link(userId, identity);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO ld_users (user_id, login, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET login = excluded.login`,
      user.id,
      login,
      new Date().toISOString()
    );
    return { userId: user.id, login };
  }

  async findUser(identity: ChannelIdentity): Promise<UserIdentity | null> {
    return this.store.findUser(identity);
  }

  async getProfile(userId: string): Promise<Profile | null> {
    const user = await this.store.getUser(userId);
    if (!user) return null;
    return {
      userId,
      login: this.login(userId),
      identities: user.channelIdentities.map((i) => ({
        channelKey: i.channelKey,
        scope: i.scope,
        subject: i.subject
      }))
    };
  }

  /** One-time code a signed-in user sends from Slack or email to link that identity. */
  async createLinkCode(userId: string): Promise<{ code: string; expiresAt: number }> {
    const code = randomCode();
    const expiresAt = Date.now() + LINK_CODE_TTL_MS;
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM ld_link_codes WHERE expires_at < ? OR user_id = ?", Date.now(), userId);
    sql.exec(
      "INSERT INTO ld_link_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)",
      await sha256Hex(code),
      userId,
      expiresAt
    );
    return { code, expiresAt };
  }

  async redeemLinkCode(code: string, identity: ChannelIdentity): Promise<RedeemResult> {
    const sql = this.ctx.storage.sql;
    const key = identityKey(identity);
    const now = Date.now();

    sql.exec("DELETE FROM ld_link_attempts WHERE at < ?", now - LINK_ATTEMPT_WINDOW_MS);
    const attempts = sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM ld_link_attempts WHERE identity_key = ?", key)
      .one().n;
    if (attempts >= MAX_LINK_ATTEMPTS) return { ok: false, reason: "rate-limited" };
    sql.exec("INSERT INTO ld_link_attempts (identity_key, at) VALUES (?, ?)", key, now);

    const hash = await sha256Hex(normalizeLinkCode(code));
    const row = sql
      .exec<{ user_id: string; expires_at: number }>(
        "SELECT user_id, expires_at FROM ld_link_codes WHERE code_hash = ?",
        hash
      )
      .toArray()[0];
    if (!row) return { ok: false, reason: "invalid" };
    sql.exec("DELETE FROM ld_link_codes WHERE code_hash = ?", hash);
    if (row.expires_at < now) return { ok: false, reason: "expired" };

    try {
      await this.store.link(row.user_id, identity);
    } catch (error) {
      if (error instanceof UserIdentityConflictError) return { ok: false, reason: "already-linked" };
      throw error;
    }
    return { ok: true, userId: row.user_id, login: this.login(row.user_id) };
  }

  async createWebhookSource(
    userId: string,
    name: string
  ): Promise<WebhookSourceSummary & { secret: string }> {
    const id = `whs_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const createdAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO ld_webhook_sources (id, user_id, name, secret, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      userId,
      name.slice(0, 80),
      secret,
      createdAt
    );
    return { id, name, createdAt, secret };
  }

  async listWebhookSources(userId: string): Promise<WebhookSourceSummary[]> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string; created_at: string }>(
        "SELECT id, name, created_at FROM ld_webhook_sources WHERE user_id = ? ORDER BY created_at",
        userId
      )
      .toArray()
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  async deleteWebhookSource(userId: string, id: string): Promise<boolean> {
    return (
      this.ctx.storage.sql.exec(
        "DELETE FROM ld_webhook_sources WHERE id = ? AND user_id = ?",
        id,
        userId
      ).rowsWritten > 0
    );
  }

  async getWebhookSource(id: string): Promise<WebhookSourceSecret | null> {
    const row = this.ctx.storage.sql
      .exec<{ id: string; user_id: string; name: string; secret: string; created_at: string }>(
        "SELECT * FROM ld_webhook_sources WHERE id = ?",
        id
      )
      .toArray()[0];
    return row
      ? { id: row.id, userId: row.user_id, name: row.name, secret: row.secret, createdAt: row.created_at }
      : null;
  }
}
