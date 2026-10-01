import { hmacSha256Hex, verifyHmacSha256Hex } from "./hmac";

/**
 * Per-user capability token for the Notes MCP server.
 *
 * Format: `<userId>.<hex HMAC-SHA256(secret, "notes:" + userId)>`. The Notes
 * server derives the user only from a token it can verify, so a caller cannot
 * read another user's notes by choosing a different id.
 */
export async function mintNotesToken(
  secret: string,
  userId: string
): Promise<string> {
  if (!userId || userId.includes(".")) throw new Error("invalid userId");
  return `${userId}.${await hmacSha256Hex(secret, `notes:${userId}`)}`;
}

export async function verifyNotesToken(
  secret: string,
  token: string
): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const ok = await verifyHmacSha256Hex(
    secret,
    `notes:${userId}`,
    token.slice(dot + 1)
  );
  return ok ? userId : null;
}
