import type { Profile, WebhookSourceSummary } from "../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export type Me = { profile: Profile; channels: { slack: boolean; email: string | null } };

export const api = {
  session: () => request<{ signedIn: boolean; login: string | null }>("/api/session"),
  me: () => request<Me>("/api/me"),
  linkCode: () => request<{ code: string; expiresAt: number }>("/api/link-code", { method: "POST" }),
  webhookSources: () => request<{ sources: WebhookSourceSummary[] }>("/api/webhook-sources"),
  createWebhookSource: (name: string) =>
    request<WebhookSourceSummary & { secret: string }>("/api/webhook-sources", {
      method: "POST",
      body: JSON.stringify({ name })
    }),
  deleteWebhookSource: (id: string) =>
    request<{ deleted: boolean }>(`/api/webhook-sources/${id}`, { method: "DELETE" }),
  testWebhook: (id: string) =>
    request<{ accepted: boolean; submissionId: string; eventId: string }>(
      `/api/webhook-sources/${id}/test`,
      { method: "POST" }
    )
};
