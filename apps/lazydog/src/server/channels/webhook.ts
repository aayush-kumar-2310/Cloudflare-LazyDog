import { hmacSha256Hex, verifyHmacSha256Hex } from "@lazydog/shared";
import { z } from "zod";
import { lazyDog } from "../agent/client";
import { registry } from "../identity/client";

export const WEBHOOK_HEADERS = {
  source: "X-LazyDog-Source",
  timestamp: "X-LazyDog-Timestamp",
  signature: "X-LazyDog-Signature"
} as const;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SKEW_SECONDS = 300;
export const WEBHOOK_EVENTS_PER_HOUR = 60;

export const webhookEventSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  event: z.string().min(1).max(100).regex(/^[\w.:-]+$/, "event must be a dotted identifier"),
  source: z.string().min(1).max(100),
  payload: z.unknown().default({})
});

/** The exact bytes that are signed: binds the source id and timestamp to the body. */
export const signedContent = (sourceId: string, timestamp: string, body: string) =>
  `${sourceId}.${timestamp}.${body}`;

export async function signWebhook(secret: string, sourceId: string, timestamp: string, body: string) {
  return `sha256=${await hmacSha256Hex(secret, signedContent(sourceId, timestamp, body))}`;
}

const reject = (status: number, error: string) => Response.json({ error }, { status });

/**
 * POST /webhook
 *
 * 1. authenticate: HMAC-SHA256 over `<source>.<timestamp>.<raw body>` with the
 *    source's secret, within a 5-minute window (replay protection)
 * 2. validate the event schema
 * 3. resolve the target agent from the *registered source*, never from the body
 * 4. deliver as an idempotent, durable turn on the restricted `webhook` channel
 *
 * The payload is only ever data for the model; the webhook channel's tool
 * allowlist keeps it from reaching code execution or destructive tools.
 */
export async function handleWebhook(request: Request, env: Env, now = Date.now()): Promise<Response> {
  if (request.method !== "POST") return reject(405, "method not allowed");

  const sourceId = request.headers.get(WEBHOOK_HEADERS.source) ?? "";
  const timestamp = request.headers.get(WEBHOOK_HEADERS.timestamp) ?? "";
  const signature = request.headers.get(WEBHOOK_HEADERS.signature) ?? "";
  if (!sourceId || !/^\d{9,11}$/.test(timestamp) || !signature.startsWith("sha256=")) {
    return reject(401, "missing or malformed signature headers");
  }
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return reject(401, "timestamp outside the allowed window");
  }

  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return reject(413, "payload too large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return reject(413, "payload too large");

  const source = await registry(env).getWebhookSource(sourceId);
  // Same response for unknown sources and bad signatures: don't reveal which ids exist.
  if (
    !source ||
    !(await verifyHmacSha256Hex(
      source.secret,
      signedContent(sourceId, timestamp, body),
      signature.slice("sha256=".length)
    ))
  ) {
    return reject(401, "invalid signature");
  }

  let parsed: z.infer<typeof webhookEventSchema>;
  try {
    const result = webhookEventSchema.safeParse(JSON.parse(body));
    if (!result.success) return reject(400, result.error.issues.map((i) => i.message).join("; "));
    parsed = result.data;
  } catch {
    return reject(400, "body must be JSON");
  }

  // Without a sender-supplied id, the signed body itself identifies the event.
  const eventId =
    parsed.id ??
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).slice(0, 16),
      (b) => b.toString(16).padStart(2, "0")
    ).join("");

  // Counted only after authentication, so unsigned junk can't exhaust a source's budget.
  const budget = await registry(env).allowWebhookDelivery(sourceId, WEBHOOK_EVENTS_PER_HOUR);
  if (!budget.allowed) {
    return Response.json(
      { error: `rate limit: ${WEBHOOK_EVENTS_PER_HOUR} events per hour per source` },
      { status: 429, headers: { "Retry-After": String(budget.retryAfterSeconds) } }
    );
  }

  const agent = await lazyDog(env, source.userId);
  const result = await agent.receiveWebhook({
    sourceId,
    sourceName: source.name,
    eventId,
    event: { id: parsed.id, event: parsed.event, source: parsed.source, payload: parsed.payload }
  });
  return Response.json({ ...result, eventId }, { status: 202 });
}
