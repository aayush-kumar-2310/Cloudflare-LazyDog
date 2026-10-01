import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, type Me } from "./api";
import { App } from "./App";
import "./styles.css";

function SignIn() {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold">🐕 LazyDog</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          A persistent agent on Cloudflare. One agent per person, reachable from web, voice, Slack, email and
          webhooks.
        </p>
      </div>
      <a
        href="/auth/login"
        className="rounded-lg bg-zinc-900 px-4 py-2 text-center font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900"
      >
        Sign in with GitHub
      </a>
      {local && (
        <a href="/auth/dev?login=demo" className="text-center text-sm text-zinc-500 underline">
          Local dev sign-in (requires DEV_LOGIN=true)
        </a>
      )}
    </main>
  );
}

function Root() {
  const [me, setMe] = useState<Me | null | "anonymous">(null);
  useEffect(() => {
    api
      .session()
      .then((s) => (s.signedIn ? api.me().then(setMe) : setMe("anonymous")))
      .catch(() => setMe("anonymous"));
  }, []);
  if (me === null) return <p className="p-6 text-zinc-500">Loading…</p>;
  if (me === "anonymous") return <SignIn />;
  return <App me={me} onProfileChange={setMe} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
