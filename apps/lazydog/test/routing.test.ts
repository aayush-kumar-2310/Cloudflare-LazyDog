import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signSession } from "../src/server/auth/session";
import { ORIGIN, signedInUser } from "./helpers";

const get = (path: string, headers: Record<string, string> = {}) =>
  exports.default.fetch(`${ORIGIN}${path}`, { headers });

describe("auth and agent routing", () => {
  it("serves the profile only to a valid session", async () => {
    expect((await get("/api/me")).status).toBe(401);
    expect((await get("/api/me", { Cookie: "ld_session=forged.deadbeef" })).status).toBe(401);

    const user = await signedInUser("octo");
    const res = await get("/api/me", { Cookie: user.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profile: { userId: user.userId, login: "octo" } });
  });

  it("rejects sessions signed with another secret or expired", async () => {
    const other = await signSession("not-the-secret", { uid: "usr_x", login: "x" });
    expect((await get("/api/me", { Cookie: `ld_session=${other}` })).status).toBe(401);
    const expired = await signSession("test-session-secret", { uid: "usr_x", login: "x" }, Date.now() - 8 * 86400_000);
    expect((await get("/api/me", { Cookie: `ld_session=${expired}` })).status).toBe(401);
  });

  it("only lets a user open their own voice bridge", async () => {
    const user = await signedInUser();
    expect((await get(`/agents/voice-bridge/usr_someoneelse`, { Cookie: user.cookie })).status).toBe(403);
    expect((await get(`/agents/voice-bridge/${user.userId}`)).status).toBe(401);
  });

  it("blocks cross-origin state changes", async () => {
    const user = await signedInUser();
    const res = await exports.default.fetch(`${ORIGIN}/api/link-code`, {
      method: "POST",
      headers: { Cookie: user.cookie, Origin: "https://evil.example" }
    });
    expect(res.status).toBe(403);
  });

  it("keeps the dev login disabled unless explicitly enabled on localhost", async () => {
    expect((await get("/auth/dev?login=x")).status).toBe(404);
  });

  it("rejects unsigned Slack requests", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/webhooks/slack`, { method: "POST", body: "{}" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
