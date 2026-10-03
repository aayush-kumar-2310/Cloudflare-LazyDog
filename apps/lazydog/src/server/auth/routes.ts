import { config } from "../config";
import { registry } from "../identity/client";
import {
  clearSessionCookie,
  cookie,
  readCookie,
  sessionCookie,
  signSession
} from "./session";

const STATE_COOKIE = "ld_oauth_state";

type GitHubUser = { id: number; login: string };

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
};

/**
 * Every turn spends the account's AI budget, so sign-in is deny-by-default:
 * ALLOWED_GITHUB_LOGINS (who are also admins) can always sign in; anyone else
 * only when the operator sets OPEN_SIGNUP=true. Open sign-up never makes
 * someone an admin.
 */
export function signInAllowed(env: Env, login: string, viaDevLogin = false): boolean {
  const c = config(env);
  if (viaDevLogin) return true;
  if (c.allowedGithubLogins.includes(login.toLowerCase())) return true;
  return c.openSignup;
}

async function startSession(
  request: Request,
  env: Env,
  github: GitHubUser,
  viaDevLogin = false
): Promise<Response> {
  const c = config(env);
  if (!signInAllowed(env, github.login, viaDevLogin)) {
    return new Response(
      c.allowedGithubLogins.length
        ? "This GitHub account is not allowed to use this LazyDog deployment."
        : "Sign-in is closed: set ALLOWED_GITHUB_LOGINS (or OPEN_SIGNUP=true) on this deployment.",
      { status: 403 }
    );
  }
  const user = await registry(env).loginWithGitHub(String(github.id), github.login);
  const token = await signSession(c.sessionSecret, { uid: user.userId, login: user.login });
  return redirect("/", [sessionCookie(request, token), cookie(request, STATE_COOKIE, "", 0)]);
}

/** GitHub OAuth (web identity) plus a localhost-only dev login. */
export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const c = config(env);
  const url = new URL(request.url);

  if (!c.sessionSecret) {
    return new Response("SESSION_SECRET is not configured.", { status: 500 });
  }

  switch (url.pathname) {
    case "/auth/login": {
      if (!c.github.clientId) {
        return new Response("GitHub OAuth is not configured (GITHUB_CLIENT_ID).", { status: 501 });
      }
      const state = crypto.randomUUID();
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", c.github.clientId);
      authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("allow_signup", "false");
      return redirect(authorize.toString(), [cookie(request, STATE_COOKIE, state, 600)]);
    }

    case "/auth/callback": {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code || state !== readCookie(request, STATE_COOKIE)) {
        return new Response("Invalid OAuth state.", { status: 400 });
      }
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: c.github.clientId,
          client_secret: c.github.clientSecret,
          code,
          redirect_uri: `${url.origin}/auth/callback`
        })
      });
      const { access_token } = (await tokenRes.json()) as { access_token?: string };
      if (!access_token) return new Response("GitHub token exchange failed.", { status: 502 });

      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "lazydog-agent"
        }
      });
      if (!userRes.ok) return new Response("GitHub user lookup failed.", { status: 502 });
      return startSession(request, env, (await userRes.json()) as GitHubUser);
    }

    case "/auth/dev": {
      // Local development only: both the DEV_LOGIN flag and a loopback host are required.
      const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
      if (!c.devLogin || !loopback) return new Response("Not found", { status: 404 });
      const login = (url.searchParams.get("login") ?? "dev").replace(/[^a-z0-9-]/gi, "");
      // Negative ids can never collide with real GitHub accounts.
      const id = -Math.abs(
        [...login].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)
      );
      return startSession(request, env, { id, login: `dev-${login}` }, true);
    }

    case "/auth/logout":
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return redirect("/", [clearSessionCookie(request)]);

    default:
      return new Response("Not found", { status: 404 });
  }
}
