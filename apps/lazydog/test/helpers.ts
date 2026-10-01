import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { LazyDog } from "../src/server/agent/lazydog";
import { signSession } from "../src/server/auth/session";
import { registry } from "../src/server/identity/client";

export const ORIGIN = "https://lazydog.test";

export async function agentFor(userId: string) {
  return getAgentByName(env.LazyDog as DurableObjectNamespace<LazyDog>, userId);
}

/** Read live agent state from inside the Durable Object. */
export async function stateOf(userId: string) {
  const stub = await agentFor(userId);
  return runInDurableObject(stub, async (instance: LazyDog) => instance.state);
}

/** Run a blocking turn inside the agent (RPC stubs can't express runTurn's overloads). */
export function turn(userId: string, input: string, channel?: string) {
  return inAgent(userId, (a) => a.runTurn({ input, channel }));
}

export async function inAgent<T>(userId: string, fn: (agent: LazyDog) => Promise<T> | T): Promise<T> {
  const stub = await agentFor(userId);
  return runInDurableObject(stub, fn);
}

/** Create a user through the same registry path GitHub sign-in uses, plus a session cookie. */
export async function signedInUser(login = `user${crypto.randomUUID().slice(0, 6)}`) {
  const githubId = String(Math.floor(Math.random() * 1e9));
  const user = await registry(env).loginWithGitHub(githubId, login);
  const token = await signSession(env.SESSION_SECRET, { uid: user.userId, login });
  return { ...user, githubId, cookie: `ld_session=${token}` };
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  { timeoutMs = 10_000, intervalMs = 50 } = {}
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
