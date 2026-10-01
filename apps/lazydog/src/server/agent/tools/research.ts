import { browserLinks, browserMarkdown } from "agents/browser";
import { tool } from "ai";
import { z } from "zod";

export type SearchSource = {
  title: string;
  url: string;
  score: number;
  snippet: string;
};

export type AiSearchResult =
  | { ok: true; query: string; sources: SearchSource[] }
  | { ok: false; error: string };

const MAX_SNIPPET_CHARS = 1_200;

/** Query an AI Search instance and normalise its chunks into citable sources. */
export async function aiSearch(
  namespace: AiSearchNamespace,
  instance: string,
  query: string,
  maxResults = 5
): Promise<AiSearchResult> {
  if (!instance) return { ok: false, error: "AI Search is not configured (AI_SEARCH_INSTANCE)." };
  try {
    const response = await namespace.get(instance).search({
      query,
      ai_search_options: { retrieval: { max_num_results: maxResults } }
    });
    return {
      ok: true,
      query: response.search_query,
      sources: response.chunks.map((chunk) => {
        const meta = chunk.item.metadata ?? {};
        return {
          title: typeof meta.title === "string" ? meta.title : chunk.item.key,
          url:
            typeof meta.url === "string"
              ? meta.url
              : /^agents\/.*\.md$/.test(chunk.item.key) // seeded docs item without metadata
                ? `https://developers.cloudflare.com/${chunk.item.key.replace(/\.md$/, "")}/`
                : chunk.item.key,
          score: Math.round(chunk.score * 1000) / 1000,
          snippet: chunk.text.slice(0, MAX_SNIPPET_CHARS)
        };
      })
    };
  } catch (error) {
    return { ok: false, error: `AI Search failed: ${(error as Error).message}` };
  }
}

/** Only public http(s) URLs; the browser runs remotely but local targets are never useful. */
export function assertBrowsableUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http(s) URLs can be opened");
  if (url.username || url.password) throw new Error("URLs with credentials cannot be opened");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^\d+$/.test(host) || // decimal IPv4 such as 2130706433
    /^0x[0-9a-f]+$/i.test(host) ||
    /^(0|10|127)\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || // carrier-grade NAT
    (host.startsWith("[") && /^\[(::1?|f[cd]|fe8|::ffff:)/i.test(host)); // loopback, ULA, link-local, mapped
  if (blocked) throw new Error("Private or local addresses cannot be opened");
  return url;
}

const MAX_REDIRECTS = 3;

/**
 * Plain HTTP GET for public pages. Redirects are followed by hand so every hop
 * is re-checked; otherwise a public URL could bounce the fetch to a local one.
 */
export async function safeFetchText(start: URL): Promise<string> {
  let url = assertBrowsableUrl(start.toString());
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, {
      headers: { Accept: "text/html,text/markdown;q=0.9,*/*;q=0.5", "User-Agent": "LazyDog/1.0 (+Cloudflare Agents)" },
      redirect: "manual"
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location");
      if (!location) throw new Error(`redirect without Location (${res.status})`);
      url = assertBrowsableUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`direct fetch failed (${res.status})`);
    return res.text();
  }
  throw new Error("too many redirects");
}

/**
 * Paces Browser Run calls. Workers Free allows one Quick Action request every
 * 10 seconds per account; calls reserve consecutive slots, so concurrent tool
 * calls queue instead of colliding.
 */
export class RateGate {
  #next = 0;
  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Reserve the next slot; returns how long the caller must wait for it. */
  reserve(): number {
    const now = this.now();
    const at = Math.max(now, this.#next);
    this.#next = at + this.intervalMs;
    return at - now;
  }

  /** Push the next slot out, e.g. after a 429 with Retry-After. */
  backoff(ms: number) {
    this.#next = Math.max(this.#next, this.now() + ms);
  }
}

export const BROWSER_INTERVAL_MS = 10_000;
/** Longer than this and we fetch directly instead of waiting for Browser Run. */
export const MAX_BROWSER_WAIT_MS = 20_000;

const isRateLimited = (error: unknown) => (error as { status?: number }).status === 429;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Crude but dependency-free HTML → readable text for the direct-fetch fallback. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, (_m, level) => `\n${"#".repeat(Number(level))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function linksFromHtml(html: string, base: URL): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href="([^"#]+)"/gi)) {
    try {
      const url = new URL(m[1], base);
      if (url.protocol === "http:" || url.protocol === "https:") out.add(url.toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...out];
}


/**
 * Run a Browser Run Quick Action with pacing; on rate limiting (or if the
 * wait would be too long) fall back to a plain HTTP fetch, and say so.
 */
export async function withBrowserFallback<T>(
  gate: RateGate,
  run: () => Promise<T>,
  fallback: () => Promise<T>
): Promise<{ value: T; via: "browser-run" | "direct-fetch"; note?: string }> {
  const wait = gate.reserve();
  if (wait > MAX_BROWSER_WAIT_MS) {
    return { value: await fallback(), via: "direct-fetch", note: "Browser Run is busy (free-plan rate limit); fetched without JavaScript rendering." };
  }
  if (wait > 0) await sleep(wait);
  try {
    return { value: await run(), via: "browser-run" };
  } catch (error) {
    if (!isRateLimited(error)) throw error;
    gate.backoff(BROWSER_INTERVAL_MS);
    return { value: await fallback(), via: "direct-fetch", note: "Browser Run rate-limited (429); fetched without JavaScript rendering." };
  }
}

export function createResearchTools(env: Env, aiSearchInstance: string, browserGate: RateGate) {
  return {
    ai_search: tool({
      description:
        "Search LazyDog's indexed knowledge base (Cloudflare docs) with AI Search. " +
        "Use this first for research questions. Returns ranked sources with snippets; cite their URLs.",
      inputSchema: z.object({
        query: z.string().min(2).describe("A focused search query"),
        maxResults: z.number().int().min(1).max(10).default(5)
      }),
      execute: ({ query, maxResults }) =>
        aiSearch(env.AI_SEARCH, aiSearchInstance, query, maxResults)
    }),

    browser_open: tool({
      description:
        "Open a public web page in a real headless browser (Cloudflare Browser Run) and return its content as Markdown. " +
        "Calls are paced; open only the pages you need.",
      inputSchema: z.object({
        url: z.string().url(),
        maxChars: z.number().int().min(500).max(40_000).default(12_000)
      }),
      execute: async ({ url, maxChars }) => {
        const target = assertBrowsableUrl(url);
        const { value: markdown, via, note } = await withBrowserFallback(
          browserGate,
          () => browserMarkdown(env.BROWSER, { url: target.toString() }),
          async () => htmlToText(await safeFetchText(target))
        );
        return {
          url: target.toString(),
          via,
          ...(note ? { note } : {}),
          truncated: markdown.length > maxChars,
          markdown: markdown.slice(0, maxChars)
        };
      }
    }),

    browser_links: tool({
      description: "List the links on a public web page, to decide what to open next.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        const target = assertBrowsableUrl(url);
        const { value: links, via, note } = await withBrowserFallback(
          browserGate,
          () => browserLinks(env.BROWSER, { url: target.toString() }),
          async () => linksFromHtml(await safeFetchText(target), target)
        );
        return { url: target.toString(), via, ...(note ? { note } : {}), links: links.slice(0, 150) };
      }
    })
  };
}
