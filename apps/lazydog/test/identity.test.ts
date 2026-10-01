import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registry, } from "../src/server/identity/client";
import { normalizeLinkCode, webIdentity } from "../src/server/identity/registry";
import { signedInUser } from "./helpers";

const slackIdentity = (subject = `U${crypto.randomUUID().slice(0, 8)}`) => ({
  channelKey: "slack",
  scope: "T123",
  subject
});

describe("IdentityRegistry", () => {
  it("returns the same user for the same GitHub account", async () => {
    const reg = registry(env);
    const a = await reg.loginWithGitHub("4242", "octocat");
    const b = await reg.loginWithGitHub("4242", "octocat-renamed");
    expect(b.userId).toBe(a.userId);
    expect((await reg.getProfile(a.userId))?.login).toBe("octocat-renamed");
    expect(await reg.findUser(webIdentity("4242"))).toMatchObject({ id: a.userId });
  });

  it("links a Slack identity with a one-time code", async () => {
    const reg = registry(env);
    const user = await signedInUser();
    const { code } = await reg.createLinkCode(user.userId);
    const slack = slackIdentity();

    expect(await reg.findUser(slack)).toBeNull();
    const result = await reg.redeemLinkCode(code.toLowerCase().replace("-", " "), slack);
    expect(result).toMatchObject({ ok: true, userId: user.userId });
    expect(await reg.findUser(slack)).toMatchObject({ id: user.userId });

    // Codes are single use.
    expect(await reg.redeemLinkCode(code, slackIdentity())).toEqual({ ok: false, reason: "invalid" });
    const profile = await reg.getProfile(user.userId);
    expect(profile?.identities.map((i) => i.channelKey).sort()).toEqual(["slack", "web"]);
  });

  it("never re-links an identity that belongs to another user", async () => {
    const reg = registry(env);
    const alice = await signedInUser();
    const bob = await signedInUser();
    const slack = slackIdentity();
    await reg.redeemLinkCode((await reg.createLinkCode(alice.userId)).code, slack);
    const hijack = await reg.redeemLinkCode((await reg.createLinkCode(bob.userId)).code, slack);
    expect(hijack).toEqual({ ok: false, reason: "already-linked" });
    expect(await reg.findUser(slack)).toMatchObject({ id: alice.userId });
  });

  it("rate-limits code guessing per identity", async () => {
    const reg = registry(env);
    const attacker = slackIdentity();
    for (let i = 0; i < 5; i++) {
      expect(await reg.redeemLinkCode("AAAA-AAAA", attacker)).toEqual({ ok: false, reason: "invalid" });
    }
    const user = await signedInUser();
    const { code } = await reg.createLinkCode(user.userId);
    expect(await reg.redeemLinkCode(code, attacker)).toEqual({ ok: false, reason: "rate-limited" });
  });

  it("normalises codes typed with spaces or lowercase", () => {
    expect(normalizeLinkCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(normalizeLinkCode("ABCD-EFGH")).toBe("ABCD-EFGH");
  });
});
