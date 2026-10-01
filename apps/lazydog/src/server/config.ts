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
    anthropicApiKey: str(env.ANTHROPIC_API_KEY),
    openaiApiKey: str(env.OPENAI_API_KEY)
  };
}

export type AppConfig = ReturnType<typeof config>;

export const slackConfigured = (c: AppConfig) =>
  Boolean(c.slack.botToken && c.slack.signingSecret);
