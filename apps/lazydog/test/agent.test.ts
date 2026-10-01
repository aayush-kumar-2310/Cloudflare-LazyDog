import type { ChannelMessageSurface } from "agents/channels";
import { describe, expect, it } from "vitest";
import { agentFor, inAgent, stateOf, turn, waitFor } from "./helpers";

const uid = () => `usr_${crypto.randomUUID().replace(/-/g, "")}`;

describe("LazyDog agent loop (scripted model, real Think runtime)", () => {
  it("runs a tool, persists the durable schedule, and logs real activity", async () => {
    const userId = uid();
    const agent = await agentFor(userId);

    const result = await turn(userId, '/tool schedule_reminder {"message":"stretch","inSeconds":120}');
    expect(result.status).toBe("completed");

    const state = await stateOf(userId);
    expect(state.reminders).toHaveLength(1);
    expect(state.reminders[0]).toMatchObject({ message: "stretch", origin: "web" });

    // Schedule really exists in the Agent scheduler (SQLite), not just in state.
    const schedules = await inAgent(userId, (a) => a.getSchedules().filter((s) => s.callback === "onReminder"));
    expect(schedules).toHaveLength(1);

    const titles = state.activity.map((e) => `${e.title}:${e.status}`);
    expect(titles).toContain("Received web message:info");
    expect(titles).toContain("Called schedule_reminder:ok");
    expect(titles).toContain("Scheduled reminder:ok");
    expect(titles).toContain("Generated response:ok");
  });

  it("persists conversation history across turns", async () => {
    const userId = uid();
    const agent = await agentFor(userId);
    await turn(userId, "first");
    await turn(userId, "second");
    const texts = await inAgent(userId, (a) =>
      a.messages.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""))
    );
    expect(texts).toEqual(["first", "echo: first", "second", "echo: second"]);
  });

  it("rejects schedules in the past without persisting anything", async () => {
    const userId = uid();
    const agent = await agentFor(userId);
    await turn(userId, '/tool schedule_reminder {"message":"too late","at":"2020-01-01T10:00:00Z"}');
    const state = await stateOf(userId);
    expect(state.reminders).toHaveLength(0);
    expect(state.activity.find((e) => e.title === "Called schedule_reminder")?.status).toBe("error");
  });

  it("fires a due reminder from the real Durable Object alarm into the web transcript", async () => {
    const userId = uid();
    // Bypass the tool's 10s minimum to keep the test fast; the alarm path is the real one.
    await inAgent(userId, (a) => a.scheduleReminder("drink water", { kind: "delay", seconds: 1 }));
    expect((await stateOf(userId)).reminders).toHaveLength(1);

    const fired = await waitFor(async () =>
      (await stateOf(userId)).activity.find((e) => e.title === "Reminder fired")
    );
    expect(fired.detail).toBe("drink water");

    const last = await inAgent(userId, (a) => a.messages.at(-1));
    expect(JSON.stringify(last?.parts)).toContain("Reminder: drink water");
    expect((await stateOf(userId)).reminders).toHaveLength(0);
  });

  it("webhook turns cannot reach tools outside the webhook allowlist", async () => {
    const userId = uid();
    const agent = await agentFor(userId);
    await turn(userId, '/tool schedule_reminder {"message":"keep me","inSeconds":300}');
    const [reminder] = (await stateOf(userId)).reminders;

    await turn(userId, `/tool cancel_reminder {"id":"${reminder.id}"}`, "webhook");
    // cancel_reminder is not on the webhook allowlist, so the reminder survives.
    expect((await stateOf(userId)).reminders).toHaveLength(1);
  });

  it("accepts inbound channel messages durably, once, and replies on the origin channel", async () => {
    const userId = uid();
    const agent = await agentFor(userId);
    const replySurface: ChannelMessageSurface = {
      channelKey: "email",
      version: 1,
      label: "alice@example.com",
      address: { from: "lazydog@example.com", to: "alice@example.com", subject: "Re: hello" }
    };
    const inbound = {
      channel: "email" as const,
      dispatchId: "dispatch-1",
      text: "hello from email",
      actor: "alice@example.com",
      replySurface
    };

    const first = await agent.receiveInbound(inbound);
    const again = await agent.receiveInbound(inbound);
    expect(first.accepted).toBe(true);
    expect(again.accepted).toBe(false);
    expect(again.submissionId).toBe(first.submissionId);

    const reply = await waitFor(async () =>
      (await stateOf(userId)).activity.find((e) => e.title === "Replied on email")
    );
    expect(reply.status).toBe("ok");

    const texts = await inAgent(userId, (a) =>
      a.messages.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""))
    );
    expect(texts).toEqual(["hello from email", "echo: hello from email"]);
  });
});
