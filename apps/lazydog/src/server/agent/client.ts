import { getAgentByName } from "agents";
import type { LazyDog } from "./lazydog";

/**
 * Stub for a user's LazyDog. The Durable Object name is the LazyDog user id;
 * `getAgentByName` also sets the agent's name so `this.name` works over RPC.
 */
export function lazyDog(env: Env, userId: string) {
  return getAgentByName(env.LazyDog as DurableObjectNamespace<LazyDog>, userId);
}
