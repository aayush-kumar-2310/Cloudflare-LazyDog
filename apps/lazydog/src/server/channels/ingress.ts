import type { ChannelHost, ChannelMessageEvent } from "agents/channels";
import { registry } from "../identity/client";
import { lazyDog } from "../agent/client";
import type { InboundChannel } from "../agent/lazydog";
import { createChannelHost, UNLINKED_ROUTE, USER_ROUTE } from "./host";

const LINK_COMMAND = /^\s*link\s+([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})\b/i;

const LINK_ERRORS = {
  invalid: "That link code is not valid. Generate a new one in the LazyDog web app.",
  expired: "That link code has expired. Generate a new one in the LazyDog web app.",
  "rate-limited": "Too many attempts. Wait ten minutes, then try a new code.",
  "already-linked": "This account is already linked to a LazyDog user."
} as const;

/**
 * Worker-side ingress for Slack and email. The ChannelHost verifies each
 * provider's signature and normalises the event; this handler resolves the
 * sender to a LazyDog user and hands the message to that user's agent, which
 * accepts it durably (a Think submission) before the provider is acknowledged.
 */
export function createIngressHost(env: Env, origin: string): ChannelHost {
  const host: ChannelHost = createChannelHost(env, {
    findUser: (identity) => registry(env).findUser(identity),
    onMessage: (event) => handleMessage(env, host, origin, event)
  });
  return host;
}

async function handleMessage(
  env: Env,
  host: ChannelHost,
  origin: string,
  { channelKey, route, dispatchId, message }: ChannelMessageEvent
): Promise<void> {
  const reply = async (markdown: string) => {
    if (message.replySurface) await host.deliver(message.replySurface, { markdown });
  };
  const text = message.message.text.trim();
  const identity = message.actor?.identity;

  const link = LINK_COMMAND.exec(text.split("\n")[0] ?? "");
  if (link && identity) {
    const result = await registry(env).redeemLinkCode(link[1], identity);
    await reply(
      result.ok
        ? `Linked. This ${channelKey} account now reaches LazyDog for @${result.login}.`
        : LINK_ERRORS[result.reason]
    );
    return;
  }

  if (route.startsWith(UNLINKED_ROUTE)) {
    await reply(
      `I don't know this ${channelKey} account yet. Sign in at ${origin}, choose ` +
        `"Link Slack / email", and send me the code as: link ABCD-1234`
    );
    return;
  }

  if (route.startsWith(USER_ROUTE) && (channelKey === "slack" || channelKey === "email")) {
    const agent = await lazyDog(env, route.slice(USER_ROUTE.length));
    await agent.receiveInbound({
      channel: channelKey as InboundChannel,
      dispatchId,
      text: message.message.title ? `${message.message.title}\n\n${text}` : text,
      actor: message.actor?.fullName ?? message.actor?.username ?? message.actor?.id ?? "unknown",
      replySurface: message.replySurface ?? null
    });
  }
}
