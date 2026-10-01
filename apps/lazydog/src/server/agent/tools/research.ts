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
  const host = url.hostname;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]"
  ) {
    throw new Error("Private or local addresses cannot be opened");
  }
  return url;
}

export function createResearchTools(env: Env, aiSearchInstance: string) {
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
        "Open a public web page in a real headless browser (Cloudflare Browser Run) and return its content as Markdown.",
      inputSchema: z.object({
        url: z.string().url(),
        maxChars: z.number().int().min(500).max(40_000).default(12_000)
      }),
      execute: async ({ url, maxChars }) => {
        const target = assertBrowsableUrl(url);
        const markdown = await browserMarkdown(env.BROWSER, { url: target.toString() });
        return {
          url: target.toString(),
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
        const links = await browserLinks(env.BROWSER, { url: target.toString() });
        return { url: target.toString(), links: links.slice(0, 150) };
      }
    })
  };
}
