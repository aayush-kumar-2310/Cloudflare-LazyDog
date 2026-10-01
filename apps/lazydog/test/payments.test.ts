import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { choosePayment, PAYMENT_NETWORK, TEST_USDC } from "../src/server/payments/policy";
import type { LazyDog } from "../src/server/agent/lazydog";
import { inAgent, stateOf } from "./helpers";

const PAY_TO = "0x00000000000000000000000000000000000000A1";
const offer = (over: Partial<Record<string, string>> = {}) => ({
  scheme: "exact",
  network: PAYMENT_NETWORK,
  amount: "10000",
  asset: TEST_USDC,
  payTo: PAY_TO,
  ...over
});
const uid = () => `usr_${crypto.randomUUID().replace(/-/g, "")}`;

describe("payment policy", () => {
  it("accepts a small test-USDC payment to our recipient on Base Sepolia", () => {
    expect(choosePayment([offer()], PAY_TO.toLowerCase())).toMatchObject({ pay: true, usd: 0.01 });
  });

  it.each([
    ["mainnet", offer({ network: "eip155:8453" })],
    ["another token", offer({ asset: "0x0000000000000000000000000000000000000001" })],
    ["another recipient", offer({ payTo: "0x00000000000000000000000000000000000000B2" })],
    ["over the cap", offer({ amount: "50001" })],
    ["zero", offer({ amount: "0" })],
    ["garbage amount", offer({ amount: "1e9" })]
  ])("refuses %s", (_label, requirement) => {
    expect(choosePayment([requirement], PAY_TO).pay).toBe(false);
  });

  it("picks the acceptable option among several", () => {
    const d = choosePayment([offer({ network: "eip155:8453" }), offer({ amount: "20000" })], PAY_TO);
    expect(d).toMatchObject({ pay: true, usd: 0.02 });
  });
});

describe("x402 premium brief (stubbed facilitator, nothing settles)", () => {
  const connectPremium = (a: LazyDog) => a.addMcpServer("premium", env.PremiumMCP as never);

  it("advertises requirements our policy accepts", async () => {
    const res = await inAgent(uid(), async (a) => {
      const { id } = await connectPremium(a);
      return a.mcp.callTool({ serverId: id, name: "premium_brief", arguments: { topic: "durable execution" } });
    });
    const accepts = (res._meta as { "x402/error": { accepts: Parameters<typeof choosePayment>[0] } })["x402/error"].accepts;
    expect(choosePayment(accepts, PAY_TO)).toMatchObject({ pay: true, usd: 0.01 });
  });

  it("exposes the buy tool only with approval required", async () => {
    const tool = await inAgent(uid(), async (a) => {
      await connectPremium(a);
      return a.getTools().buy_premium_brief;
    });
    expect(tool?.needsApproval).toBe(true);
  });

  it("signs a policy-approved payment and submits it to the facilitator", async () => {
    const userId = uid();
    const result = await inAgent(userId, async (a) => {
      await connectPremium(a);
      return (a as unknown as { buyPremiumBrief(t: string): Promise<{ error?: string }> }).buyPremiumBrief("fibers");
    });
    // The stub facilitator rejects every payment, so the tool reports failure…
    expect(result.error).toBeTruthy();
    // …but only after our policy authorized it and a signed payload was sent for verification.
    const activity = (await stateOf(userId)).activity.map((e) => e.title);
    expect(activity).toContain("Payment authorized: $0.01 test USDC (Base Sepolia)");
    const verified = (await (await fetch("https://slack-mock.test/__facilitator")).json()) as Array<Record<string, unknown>>;
    expect(JSON.stringify(verified)).toContain(PAY_TO);
  });
});
