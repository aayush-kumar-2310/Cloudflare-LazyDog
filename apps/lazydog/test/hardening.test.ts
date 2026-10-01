import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { assertBrowsableUrl, safeFetchText } from "../src/server/agent/tools/research";
import { signInAllowed } from "../src/server/auth/routes";
import { signWebhook, WEBHOOK_EVENTS_PER_HOUR, WEBHOOK_HEADERS } from "../src/server/channels/webhook";
import { registry } from "../src/server/identity/client";
import { inAgent, ORIGIN, signedInUser, stateOf } from "./helpers";

const uid = () => `usr_${crypto.randomUUID().replace(/-/g, "")}`;

describe("hardening", () => {
  it("rejects client-originated state writes but allows the agent's own", async () => {
    const userId = uid();
    const state = await stateOf(userId);
    await inAgent(userId, (a) => {
      expect(() => a.validateStateChange(state, { id: "browser-connection" })).toThrow(/read-only/);
      expect(() => a.validateStateChange(state, "server")).not.toThrow();
    });
  });

  it("validates callable inputs", async () => {
    const userId = uid();
    await inAgent(userId, async (a) => {
      expect(() => a.startResearchJobFromUi("x".repeat(500))).toThrow(/3–200/);
      expect(() => a.startResearchJobFromUi("valid topic", "everything")).toThrow(/crashAfter/);
      expect(a.setTimezone("Not/AZone")).toEqual({ ok: false });
      expect(a.setTimezone({ evil: true })).toEqual({ ok: false });
      expect(await a.cancelReminderFromUi(42)).toBe(false);
    });
  });

  it("is deny-by-default for sign-in", () => {
    const base = { ...env, ALLOWED_GITHUB_LOGINS: "", OPEN_SIGNUP: "false" } as unknown as Env;
    expect(signInAllowed(base, "stranger")).toBe(false);
    expect(signInAllowed(base, "dev-local", true)).toBe(true);
    expect(signInAllowed({ ...base, OPEN_SIGNUP: "true" } as unknown as Env, "stranger")).toBe(true);
    const listed = { ...base, ALLOWED_GITHUB_LOGINS: "Octocat, someone" } as unknown as Env;
    expect(signInAllowed(listed, "octocat")).toBe(true);
    expect(signInAllowed({ ...listed, OPEN_SIGNUP: "true" } as unknown as Env, "stranger")).toBe(false);
  });

  it("refuses agent sockets from another origin", async () => {
    const user = await signedInUser();
    const res = await exports.default.fetch(`${ORIGIN}/agent/get-messages`, {
      headers: { Cookie: user.cookie, Origin: "https://evil.kumar-aayush2310.workers.dev" }
    });
    expect(res.status).toBe(403);
    const ok = await exports.default.fetch(`${ORIGIN}/agent/get-messages`, { headers: { Cookie: user.cookie, Origin: ORIGIN } });
    expect(ok.status).toBe(200);
  });

  it("rate-limits authenticated webhook deliveries per source", async () => {
    const user = await signedInUser();
    const reg = registry(env);
    const source = await reg.createWebhookSource(user.userId, "noisy");
    for (let i = 0; i < WEBHOOK_EVENTS_PER_HOUR; i++) {
      expect((await reg.allowWebhookDelivery(source.id, WEBHOOK_EVENTS_PER_HOUR)).allowed).toBe(true);
    }
    const body = JSON.stringify({ id: "evt-over", event: "ci.failed", source: "ci", payload: {} });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await exports.default.fetch(`${ORIGIN}/webhook`, {
      method: "POST",
      headers: {
        [WEBHOOK_HEADERS.source]: source.id,
        [WEBHOOK_HEADERS.timestamp]: ts,
        [WEBHOOK_HEADERS.signature]: await signWebhook(source.secret, source.id, ts, body)
      },
      body
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("blocks private and obfuscated addresses", () => {
    for (const bad of [
      "http://0.0.0.0/", "http://2130706433/", "http://0x7f000001/", "http://localhost./",
      "http://100.64.0.1/", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/",
      "http://user:pass@example.com/", "http://printer.local/"
    ]) {
      expect(() => assertBrowsableUrl(bad), bad).toThrow();
    }
    expect(assertBrowsableUrl("https://developers.cloudflare.com/agents/").host).toBe("developers.cloudflare.com");
  });

  it("re-checks every redirect hop in the direct-fetch fallback", async () => {
    await expect(safeFetchText(new URL("https://redirect.example.com/start"))).rejects.toThrow(/Private or local/);
    expect(await safeFetchText(new URL("https://page.example.com/"))).toContain("Public page");
  });
});
