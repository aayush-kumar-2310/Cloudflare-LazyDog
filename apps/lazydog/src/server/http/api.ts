import { z } from "zod";
import type { Session } from "../auth/session";
import { isSameOrigin } from "../auth/session";
import { handleWebhook, signWebhook, WEBHOOK_HEADERS } from "../channels/webhook";
import { config, slackConfigured } from "../config";
import { registry } from "../identity/client";
import { seedSearchBatch } from "./seed-search";
import type { SearchIndexStatus } from "../../shared/types";

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

/**
 * Admins may run account-level maintenance (seeding AI Search). Production:
 * logins listed in ALLOWED_GITHUB_LOGINS. Local dev: the dev login on a
 * loopback host.
 */
export function isAdmin(request: Request, env: Env, session: Session): boolean {
  const c = config(env);
  if (c.allowedGithubLogins.includes(session.login.toLowerCase())) return true;
  const host = new URL(request.url).hostname;
  return c.devLogin && ["localhost", "127.0.0.1"].includes(host) && session.login.startsWith("dev-");
}

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
    const admin = isAdmin(request, env, session);
    // First admin visit on a fresh deploy starts seeding the docs index.
    let searchIndex: SearchIndexStatus | null = null;
    if (admin && c.aiSearchInstance) {
      searchIndex = await reg.ensureSearchSeeded(c.aiSearchInstance).catch((error: Error) => ({
        status: "failed" as const,
        uploaded: 0,
        total: 0,
        error: error.message
      }));
    }
    return Response.json({
      profile,
      isAdmin: admin,
      searchIndex,
      channels: {
        slack: slackConfigured(c),
        email: c.emailFrom || null
      }
    });
  }

  if (path === "/admin/seed-search" && method === "POST") {
    if (!isAdmin(request, env, session)) return Response.json({ error: "forbidden" }, { status: 403 });
    const instance = config(env).aiSearchInstance;
    if (!instance) return Response.json({ error: "AI_SEARCH_INSTANCE is not configured" }, { status: 400 });
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    try {
      return Response.json(await seedSearchBatch(env.AI_SEARCH, instance, offset));
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 502 });
    }
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
