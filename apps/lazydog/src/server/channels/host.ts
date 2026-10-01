import {
  ChannelHost,
  identityKey,
  type Channel,
  type ChannelHostOptions,
  type ChannelIngressEvent,
  type ChannelRouteContext
} from "agents/channels";
import { email, type InboundEmailRaw } from "agents/channels/email";
import { slack } from "agents/channels/slack";
import { config, slackConfigured } from "../config";

export const USER_ROUTE = "user:";
export const UNLINKED_ROUTE = "unlinked:";

/**
 * Route by explicitly linked user, never by guessing. Linked senders reach
 * their own LazyDog; everyone else gets an `unlinked:` route that the ingress
 * handler answers with sign-in instructions (and link-code redemption).
 */
async function routeByLinkedUser(
  event: ChannelIngressEvent,
  context: ChannelRouteContext
): Promise<string | null> {
  const user = await context.findUser();
  if (user) return `${USER_ROUTE}${user.id}`;
  const identity = event.actor?.identity;
  return identity ? `${UNLINKED_ROUTE}${identityKey(identity)}` : null;
}

/**
 * Inbound mail must be authenticated by its sending domain. Cloudflare Email
 * Routing records SPF/DKIM/DMARC verdicts in Authentication-Results headers;
 * without a DMARC or DKIM pass, the From address is only a claim.
 */
export function isAuthenticatedEmail(raw: { headers: ReadonlyArray<{ key: string; value: string }> }): boolean {
  return raw.headers.some(
    (h) =>
      /^(arc-)?authentication-results$/i.test(h.key) && /\b(dmarc|dkim)=pass\b/i.test(h.value)
  );
}

export function slackAddressed(event: ChannelIngressEvent): boolean {
  if (event.type !== "message") return true; // approval responses
  if (event.actor?.isBot === true || event.actor?.isSelf) return false;
  return event.thread.isDirectMessage === true || event.message.isMention === true;
}

export function createChannelHost(
  env: Env,
  handlers: Pick<ChannelHostOptions, "findUser" | "onMessage" | "onApprovalResponse"> = {}
): ChannelHost {
  const c = config(env);
  const channels: Record<string, Channel> = {};

  if (slackConfigured(c)) {
    channels.slack = slack({
      botToken: c.slack.botToken,
      webhook: {
        signingSecret: c.slack.signingSecret,
        botUserId: c.slack.botUserId || undefined,
        path: "/webhooks/slack"
      },
      route: (event, _raw, context) =>
        slackAddressed(event) ? routeByLinkedUser(event, context) : null
    }) as Channel;
  }

  if (c.emailFrom) {
    channels.email = email({
      binding: env.EMAIL as unknown as Parameters<typeof email>[0]["binding"],
      from: { email: c.emailFrom, name: "LazyDog" },
      defaultTitle: "LazyDog",
      route: (event, raw, context) => {
        if (event.type === "message" && event.message.metadata?.autoReply) return null;
        return isAuthenticatedEmail(raw) ? routeByLinkedUser(event, context) : null;
      }
    }) as Channel;
  }

  return new ChannelHost({ channels, ...handlers });
}
