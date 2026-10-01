import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signWebhook, WEBHOOK_HEADERS } from "../src/server/channels/webhook";
import { registry } from "../src/server/identity/client";
import { ORIGIN, signedInUser, stateOf, waitFor } from "./helpers";

const event = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ id: `evt-${crypto.randomUUID()}`, event: "repository.push", source: "demo", payload: { ref: "main" }, ...overrides });

async function send(
  sourceId: string,
  secret: string,
  body: string,
  { timestamp = String(Math.floor(Date.now() / 1000)), signature }: { timestamp?: string; signature?: string } = {}
) {
  return exports.default.fetch(`${ORIGIN}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [WEBHOOK_HEADERS.source]: sourceId,
      [WEBHOOK_HEADERS.timestamp]: timestamp,
      [WEBHOOK_HEADERS.signature]: signature ?? (await signWebhook(secret, sourceId, timestamp, body))
    },
    body
  });
}

async function newSource() {
  const user = await signedInUser();
  const source = await registry(env).createWebhookSource(user.userId, "github-demo");
  return { user, source };
}

describe("POST /webhook", () => {
  it("delivers a signed event to the owning user's agent as a durable turn", async () => {
    const { user, source } = await newSource();
    const res = await send(source.id, source.secret, event());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });

    const accepted = await waitFor(async () =>
      (await stateOf(user.userId)).activity.find((e) => e.title === "Webhook repository.push accepted")
    );
    expect(accepted.channel).toBe("webhook");
    await waitFor(async () =>
      (await stateOf(user.userId)).activity.find((e) => e.kind === "response" && e.channel === "webhook")
    );
  });

  it("is idempotent for redelivered events", async () => {
    const { source } = await newSource();
    const body = event({ id: "evt-fixed" });
    expect(await (await send(source.id, source.secret, body)).json()).toMatchObject({ accepted: true });
    expect(await (await send(source.id, source.secret, body)).json()).toMatchObject({ accepted: false });
  });

  it("rejects bad signatures, unknown sources, and replays outside the window", async () => {
    const { source } = await newSource();
    const body = event();
    expect((await send(source.id, "wrong-secret", body)).status).toBe(401);
    expect((await send("whs_0000000000000000", source.secret, body)).status).toBe(401);

    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await send(source.id, source.secret, body, { timestamp: stale })).status).toBe(401);

    // A signature for one body does not authorise another.
    const signature = await signWebhook(source.secret, source.id, String(Math.floor(Date.now() / 1000)), body);
    expect((await send(source.id, source.secret, event(), { signature })).status).toBe(401);
  });

  it("validates the event schema and size after authentication", async () => {
    const { source } = await newSource();
    expect((await send(source.id, source.secret, JSON.stringify({ payload: {} }))).status).toBe(400);
    expect((await send(source.id, source.secret, "not json")).status).toBe(400);
    const huge = event({ payload: { blob: "x".repeat(70 * 1024) } });
    expect((await send(source.id, source.secret, huge)).status).toBe(413);
  });

  it("lets a signed-in user fire a signed test event through the same path", async () => {
    const { user, source } = await newSource();
    const res = await exports.default.fetch(`${ORIGIN}/api/webhook-sources/${source.id}/test`, {
      method: "POST",
      headers: { Cookie: user.cookie, Origin: ORIGIN }
    });
    expect(res.status).toBe(202);

    const other = await signedInUser();
    const forbidden = await exports.default.fetch(`${ORIGIN}/api/webhook-sources/${source.id}/test`, {
      method: "POST",
      headers: { Cookie: other.cookie, Origin: ORIGIN }
    });
    expect(forbidden.status).toBe(404);
  });
});
