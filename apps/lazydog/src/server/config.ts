/**
 * Typed view over vars and secrets. `wrangler types` renders vars as string
 * literals, so everything is read through here as plain strings, and
 * "configured" means non-empty.
 */
export type ModelProvider = "workers-ai" | "anthropic" | "openai" | "mock";

const str = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export function config(env: Env) {
  const provider = str(env.MODEL_PROVIDER) as ModelProvider;
  return {
    modelProvider: (["workers-ai", "anthropic", "openai", "mock"] as const).includes(provider)
      ? provider
      : "workers-ai",
    /** Test/offline only; never set in wrangler.jsonc. */
    allowMockModel: str((env as { ALLOW_MOCK_MODEL?: unknown }).ALLOW_MOCK_MODEL) === "true",
    modelId: str(env.MODEL_ID),
    aiSearchInstance: str(env.AI_SEARCH_INSTANCE),
    notesMcpUrl: str(env.NOTES_MCP_URL).includes("<") ? "" : str(env.NOTES_MCP_URL),
    notesMcpSecret: str(env.NOTES_MCP_SECRET),
    emailFrom: str(env.EMAIL_FROM),
    /** Used in email replies, where there is no request origin. */
    publicUrl: str(env.PUBLIC_URL),
    defaultTimezone: str(env.DEFAULT_TIMEZONE) || "UTC",
    allowedGithubLogins: str(env.ALLOWED_GITHUB_LOGINS)
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
    /** With no allowlist, sign-in is refused unless this is explicitly "true". */
    openSignup: str((env as { OPEN_SIGNUP?: unknown }).OPEN_SIGNUP) === "true",
    sessionSecret: str(env.SESSION_SECRET),
    github: {
      clientId: str(env.GITHUB_CLIENT_ID),
      clientSecret: str(env.GITHUB_CLIENT_SECRET)
    },
    devLogin: str(env.DEV_LOGIN) === "true",
    slack: {
      botToken: str(env.SLACK_BOT_TOKEN),
      signingSecret: str(env.SLACK_SIGNING_SECRET),
      botUserId: str(env.SLACK_BOT_USER_ID)
    },
    /** x402 payments (testnet): recipient address (var) and the agent's signing key (secret). */
    x402PayTo: str((env as { X402_PAY_TO?: unknown }).X402_PAY_TO),
    x402PrivateKey: str((env as { X402_PRIVATE_KEY?: unknown }).X402_PRIVATE_KEY),
    anthropicApiKey: str(env.ANTHROPIC_API_KEY),
    openaiApiKey: str(env.OPENAI_API_KEY)
  };
}

export type AppConfig = ReturnType<typeof config>;

export const slackConfigured = (c: AppConfig) =>
  Boolean(c.slack.botToken && c.slack.signingSecret);

export const paymentsConfigured = (env: Env) => {
  const c = config(env);
  return Boolean(
    /^0x[0-9a-fA-F]{40}$/.test(c.x402PayTo) &&
      /^0x[0-9a-fA-F]{64}$/.test(c.x402PrivateKey) &&
      (env as { PremiumMCP?: unknown }).PremiumMCP
  );
};
