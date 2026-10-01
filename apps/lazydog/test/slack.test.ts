import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { hmacSha256Hex } from "@lazydog/shared";
import { describe, expect, it } from "vitest";
import { registry } from "../src/server/identity/client";
import { ORIGIN, signedInUser, stateOf, waitFor } from "./helpers";

type SlackCall = { method: string; body: Record<string, unknown> };

const calls = async (): Promise<SlackCall[]> =>
  (await fetch("https://slack-mock.test/__calls")).json();

/** A Slack Events API callback, signed the way Slack signs it. */
async function slackEvent(
  event: Record<string, unknown>,
  { team = "T1", secret = "slack-test-secret" }: { team?: string; secret?: string } = {}
) {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: team,
    event_id: `Ev${crypto.randomUUID().slice(0, 8)}`,
    event: { ts: `${Date.now() / 1000}`, channel: "D1", ...event }
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${body}`)}`;
  return exports.default.fetch(`${ORIGIN}/webhooks/slack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature
    },
    body
  });
}

const dm = (user: string, text: string) => ({ type: "message", channel_type: "im", user, text });
const textOf = (c: SlackCall) => JSON.stringify(c.body);

describe("Slack channel", () => {
  it("rejects events with a bad signature", async () => {
    const res = await slackEvent(dm("U9", "hi"), { secret: "wrong" });
    expect(res.status).toBe(401);
  });

  it("onboards an unknown Slack user without creating an agent turn", async () => {
    await calls();
    expect((await slackEvent(dm("U_STRANGER", "hello"))).status).toBe(200);
    const posted = await waitFor(async () => (await calls()).find((c) => c.method === "chat.postMessage"));
    expect(textOf(posted)).toContain("link ABCD-1234");
  });

  it("links a Slack user with a code, then routes their DMs to the same LazyDog", async () => {
    const user = await signedInUser();
    const slackUser = `U${crypto.randomUUID().slice(0, 6)}`;
    const { code } = await registry(env).createLinkCode(user.userId);
    await calls();

    expect((await slackEvent(dm(slackUser, `link ${code}`))).status).toBe(200);
    const linked = await waitFor(async () => (await calls()).find((c) => textOf(c).includes("Linked")));
    expect(linked.method).toBe("chat.postMessage");
    expect(await registry(env).findUser({ channelKey: "slack", scope: "T1", subject: slackUser })).toMatchObject({
      id: user.userId
    });

    expect((await slackEvent(dm(slackUser, "hello from slack"))).status).toBe(200);
    const reply = await waitFor(async () =>
      (await stateOf(user.userId)).activity.find((e) => e.title === "Replied on slack")
    );
    expect(reply.status).toBe("ok");
    expect(JSON.stringify(await calls())).toContain("echo: hello from slack");
  });

  it("ignores ambient channel messages that don't mention the bot", async () => {
    await calls();
    const res = await slackEvent({ type: "message", channel_type: "channel", user: "U2", text: "lunch?", channel: "C1" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await calls()).toEqual([]);
  });
});
