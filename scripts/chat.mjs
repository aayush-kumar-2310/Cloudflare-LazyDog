#!/usr/bin/env node
// Talk to a running LazyDog from the terminal over the same WebSocket chat
// protocol the web UI uses. Prints tool calls, tool results, approval
// requests and the streamed answer. Useful for smoke-testing real services.
//
//   node scripts/chat.mjs "Explain Cloudflare durable execution." [--login demo]
//        [--url http://localhost:5173] [--approve | --reject]
//
// Signs in with the local dev login (requires DEV_LOGIN=true on localhost).
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "http://localhost:5173" },
    login: { type: "string", default: "demo" },
    approve: { type: "boolean", default: false },
    reject: { type: "boolean", default: false },
    timeout: { type: "string", default: "180" }
  }
});
const text = positionals.join(" ").trim();
if (!text) {
  console.error('Usage: node scripts/chat.mjs "your message" [--login name] [--approve|--reject]');
  process.exit(2);
}

const base = values.url.replace(/\/$/, "");
const signIn = await fetch(`${base}/auth/dev?login=${encodeURIComponent(values.login)}`, { redirect: "manual" });
const cookie = (signIn.headers.get("set-cookie") ?? "").match(/ld_session=[^;]+/)?.[0];
if (!cookie) {
  console.error(`Dev sign-in failed (${signIn.status}). Is DEV_LOGIN=true and the server on ${base}?`);
  process.exit(1);
}

// Think persists the transcript; send it with the new message like useAgentChat does.
const history = await (await fetch(`${base}/agent/get-messages`, { headers: { Cookie: cookie } })).json();
const userMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };

const ws = new WebSocket(`${base.replace(/^http/, "ws")}/agent`, { headers: { Cookie: cookie } });
const started = Date.now();
let pendingApprovals = 0;
let streaming = false;
const out = (s) => process.stdout.write(s);
const short = (v, n = 300) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

const finish = (code) => {
  out(`\n\n[${((Date.now() - started) / 1000).toFixed(1)}s]\n`);
  ws.close();
  process.exit(code);
};
setTimeout(() => {
  console.error(`\n[timeout after ${values.timeout}s]`);
  finish(1);
}, Number(values.timeout) * 1000);

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: crypto.randomUUID(),
      init: { method: "POST", body: JSON.stringify({ messages: [...history, userMessage], trigger: "submit-message" }) }
    })
  );
  out(`> ${text}\n\n`);
});

ws.addEventListener("message", (event) => {
  let msg;
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    return;
  }
  if (msg.type !== "cf_agent_use_chat_response") return;
  if (msg.error) {
    out(`\n[error] ${short(msg.body)}\n`);
    return finish(1);
  }
  if (msg.body) {
    let chunk;
    try {
      chunk = JSON.parse(msg.body);
    } catch {
      chunk = null;
    }
    if (chunk) handleChunk(chunk);
  }
  if (msg.done && pendingApprovals === 0) finish(0);
});

function handleChunk(c) {
  switch (c.type) {
    case "text-delta":
      if (!streaming) out("\n");
      streaming = true;
      out(c.delta);
      break;
    case "tool-input-available":
      streaming = false;
      out(`\n🔧 ${c.toolName} ${short(c.input, 200)}\n`);
      break;
    case "tool-output-available":
      out(`   ↳ ${short(c.output)}\n`);
      break;
    case "tool-output-error":
      out(`   ↳ ERROR ${short(c.errorText)}\n`);
      break;
    case "tool-approval-request": {
      out(`\n⏸  approval requested (${c.toolCallId})`);
      if (values.approve || values.reject) {
        pendingApprovals++;
        out(values.approve ? " → approving\n" : " → rejecting\n");
        ws.send(JSON.stringify({ type: "cf_agent_tool_approval", toolCallId: c.toolCallId, approved: values.approve, autoContinue: true }));
        // The continuation arrives as a new streamed response.
        setTimeout(() => pendingApprovals--, 500);
      } else out(" — rerun with --approve or --reject\n");
      break;
    }
    case "source-url":
      out(`\n📎 ${c.title ?? ""} ${c.url}`);
      break;
    case "error":
      out(`\n[error] ${short(c.errorText)}\n`);
      break;
  }
}
