#!/usr/bin/env node
// Sign and send a webhook event to LazyDog, exactly as an external sender would.
//
//   npm run webhook:send -w apps/lazydog -- \
//     --url http://localhost:5173/webhook --source whs_... --secret <hex> \
//     [--event repository.push] [--payload '{"ref":"main"}'] [--id evt-123]
//
// Signature: X-LazyDog-Signature = "sha256=" + hex(HMAC-SHA256(secret, `${source}.${timestamp}.${body}`))
import { createHmac, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5173/webhook" },
    source: { type: "string" },
    secret: { type: "string" },
    event: { type: "string", default: "repository.push" },
    origin: { type: "string", default: "demo" },
    payload: { type: "string", default: '{"repository":"acme/lazydog","branch":"main","commits":[{"id":"a1b2c3d","message":"Fix flaky test"}]}' },
    id: { type: "string" }
  }
});

if (!values.source || !values.secret) {
  console.error("Required: --source <whs_...> --secret <hex>  (create a source in the LazyDog web app)");
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(values.payload);
} catch {
  console.error("--payload must be valid JSON");
  process.exit(2);
}

const body = JSON.stringify({
  id: values.id ?? `evt-${randomUUID()}`,
  event: values.event,
  source: values.origin,
  payload
});
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", values.secret)
  .update(`${values.source}.${timestamp}.${body}`)
  .digest("hex");

const res = await fetch(values.url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-LazyDog-Source": values.source,
    "X-LazyDog-Timestamp": timestamp,
    "X-LazyDog-Signature": `sha256=${signature}`
  },
  body
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
