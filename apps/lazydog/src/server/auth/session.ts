import { hmacSha256Hex, verifyHmacSha256Hex } from "@lazydog/shared";

export type Session = {
  /** LazyDog user id; also the LazyDog Durable Object name. */
  uid: string;
  login: string;
  /** Expiry, epoch seconds. */
  exp: number;
};

export const SESSION_COOKIE = "ld_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const b64url = {
  encode: (text: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(text)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
  decode: (value: string) => {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
};

export async function signSession(
  secret: string,
  session: Omit<Session, "exp">,
  now = Date.now()
): Promise<string> {
  const payload = b64url.encode(
    JSON.stringify({ ...session, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS })
  );
  return `${payload}.${await hmacSha256Hex(secret, `session:${payload}`)}`;
}

export async function verifySession(
  secret: string,
  token: string | undefined,
  now = Date.now()
): Promise<Session | null> {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!(await verifyHmacSha256Hex(secret, `session:${payload}`, token.slice(dot + 1)))) {
    return null;
  }
  try {
    const session = JSON.parse(b64url.decode(payload)) as Session;
    if (typeof session.uid !== "string" || typeof session.exp !== "number") return null;
    return session.exp * 1000 > now ? session : null;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export function cookie(
  request: Request,
  name: string,
  value: string,
  maxAgeSeconds: number
): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export const sessionCookie = (request: Request, token: string) =>
  cookie(request, SESSION_COOKIE, token, SESSION_TTL_SECONDS);

export const clearSessionCookie = (request: Request) =>
  cookie(request, SESSION_COOKIE, "", 0);

export async function getSession(request: Request, secret: string) {
  return verifySession(secret, readCookie(request, SESSION_COOKIE));
}

/**
 * Cookie-authenticated state-changing requests must come from our own origin.
 * SameSite=Lax already blocks most cross-site POSTs; this closes the rest.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin;
}
