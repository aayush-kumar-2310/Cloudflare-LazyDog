import { z } from "zod";
import type { Session } from "../auth/session";
import { isSameOrigin } from "../auth/session";
import { handleWebhook, signWebhook, WEBHOOK_HEADERS } from "../channels/webhook";
import { config, slackConfigured } from "../config";
import { registry } from "../identity/client";

const createSourceSchema = z.object({ name: z.string().trim().min(1).max(80) });

const SAMPLE_EVENT = (sourceName: string) => ({
  id: `test-${crypto.randomUUID()}`,
  event: "repository.push",
  source: sourceName,
  payload: {
    repository: "acme/lazydog",
    branch: "main",
    pusher: "octocat",
    commits: [
      { id: "a1b2c3d", message: "Fix flaky durable-execution test" },
      { id: "e4f5a6b", message: "Add Slack channel docs" }
    ]
  }
});

/** Authenticated JSON API used by the web app. */
export async function handleApi(request: Request, env: Env, session: Session): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;
  if (method !== "GET" && !isSameOrigin(request)) {
    return Response.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const reg = registry(env);

  if (path === "/me" && method === "GET") {
    const c = config(env);
    const profile = await reg.getProfile(session.uid);
    return Response.json({
      profile,
      channels: {
        slack: slackConfigured(c),
        email: c.emailFrom || null
      }
    });
  }

  if (path === "/link-code" && method === "POST") {
    return Response.json(await reg.createLinkCode(session.uid));
  }

  if (path === "/webhook-sources" && method === "GET") {
    return Response.json({ sources: await reg.listWebhookSources(session.uid) });
  }

  if (path === "/webhook-sources" && method === "POST") {
    const parsed = createSourceSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "name is required" }, { status: 400 });
    // The secret is returned exactly once, at creation.
    return Response.json(await reg.createWebhookSource(session.uid, parsed.data.name), { status: 201 });
  }

  const match = /^\/webhook-sources\/(whs_[a-f0-9]{16})(\/test)?$/.exec(path);
  if (match) {
    const [, id, test] = match;
    const source = await reg.getWebhookSource(id);
    if (!source || source.userId !== session.uid) return Response.json({ error: "not found" }, { status: 404 });

    if (!test && method === "DELETE") {
      return Response.json({ deleted: await reg.deleteWebhookSource(session.uid, id) });
    }

    if (test && method === "POST") {
      // Dev/test trigger: sign a sample event server-side and run it through the
      // exact same verification path as an external sender.
      const body = JSON.stringify(SAMPLE_EVENT(source.name));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signed = new Request(new URL("/webhook", url.origin), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [WEBHOOK_HEADERS.source]: id,
          [WEBHOOK_HEADERS.timestamp]: timestamp,
          [WEBHOOK_HEADERS.signature]: await signWebhook(source.secret, id, timestamp, body)
        },
        body
      });
      return handleWebhook(signed, env);
    }
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
