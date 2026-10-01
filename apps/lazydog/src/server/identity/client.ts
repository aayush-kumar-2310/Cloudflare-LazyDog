import type { IdentityRegistry } from "./registry";

export function registry(env: Env): DurableObjectStub<IdentityRegistry> {
  const ns = env.IdentityRegistry as DurableObjectNamespace<IdentityRegistry>;
  return ns.get(ns.idFromName("global"));
}
