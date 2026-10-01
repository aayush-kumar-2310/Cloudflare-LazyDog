import { getAgentByName } from "agents";
import { handleAuth } from "./auth/routes";
import { getSession } from "./auth/session";
import { createIngressHost } from "./channels/ingress";
import { handleWebhook } from "./channels/webhook";
import { config } from "./config";
import { handleApi } from "./http/api";
import type { LazyDog } from "./agent/lazydog";
import type { VoiceBridge } from "./voice/voice-bridge";

export { LazyDog } from "./agent/lazydog";
export { IdentityRegistry } from "./identity/registry";
export { VoiceBridge } from "./voice/voice-bridge";
// Container-backed Sandbox Durable Object; bound only in the `paid` environment.
export { Sandbox } from "@cloudflare/sandbox";

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (under(pathname, "/auth")) return handleAuth(request, env);

    // Machine-to-machine channels authenticate themselves (HMAC / provider signatures).
    if (pathname === "/webhook") return handleWebhook(request, env);
    if (under(pathname, "/webhooks")) {
      const response = await createIngressHost(env, url.origin).handleRequest(request);
      return response ?? new Response("Not found", { status: 404 });
    }

    // Everything below acts as a signed-in user. The agent instance is chosen
    // from the verified session, never from the URL, so a client cannot
    // address another user's agent.
    const session = await getSession(request, config(env).sessionSecret);

    if (under(pathname, "/api")) {
      if (pathname === "/api/session") return Response.json({ signedIn: Boolean(session), login: session?.login ?? null });
      return session ? handleApi(request, env, session) : unauthorized();
    }

    if (under(pathname, "/agent")) {
      if (!session) return unauthorized();
      const agent = await getAgentByName(env.LazyDog as DurableObjectNamespace<LazyDog>, session.uid);
      return agent.fetch(request);
    }

    // The voice client has no basePath option, so it uses the standard agent
    // URL; the instance name in it must be the caller's own user id.
    const voice = /^\/agents\/voice-bridge\/([^/]+)(\/.*)?$/.exec(pathname);
    if (voice) {
      if (!session) return unauthorized();
      if (decodeURIComponent(voice[1]) !== session.uid) return Response.json({ error: "forbidden" }, { status: 403 });
      const bridge = await getAgentByName(env.VoiceBridge as DurableObjectNamespace<VoiceBridge>, session.uid);
      return bridge.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },

  async email(message, env) {
    // Inbound mail from an Email Routing rule. Senders are resolved to users
    // only through explicit identity links (see docs/IDENTITY.md).
    await createIngressHost(env, config(env).publicUrl || "the LazyDog web app").handleEmail(message);
  }
} satisfies ExportedHandler<Env>;
