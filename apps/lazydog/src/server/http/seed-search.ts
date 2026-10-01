/**
 * Seed the AI Search instance with the Cloudflare Agents documentation.
 *
 * AI Search's web crawler only indexes sites you own, so LazyDog uploads the
 * official docs as Markdown items instead (the `.md` form every
 * developers.cloudflare.com page publishes). Runs in batches because a free
 * plan Worker invocation may make at most 50 subrequests.
 */
export const DOCS_INDEX = "https://developers.cloudflare.com/agents/llms.txt";
export const BATCH_SIZE = 20;

/** Doc page URLs (as published `.../index.md`) listed in the llms.txt index. */
export function docUrlsFromIndex(index: string): string[] {
  const urls = index.match(/https:\/\/developers\.cloudflare\.com\/agents\/[^\s)]*index\.md/g) ?? [];
  return [...new Set(urls)].sort();
}

/** Drop navigation chrome and the JSON-LD footer; keep the article. */
export function cleanDocMarkdown(markdown: string): { title: string; body: string } {
  const title = /^title:\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? "Cloudflare Agents docs";
  let body = markdown.replace(/^---[\s\S]*?---\s*/, "");
  body = body.replace(/\[Skip to content\][\s\S]*?(?=^# )/m, "");
  body = body.replace(/^Last updated .*\|.*$/m, "");
  body = body.replace(/^Was this helpful\?[\s\S]*$/m, "");
  body = body.replace(/^## On this page[\s\S]*$/m, "");
  return { title, body: body.replace(/\n{3,}/g, "\n\n").trim() };
}

/** Item key for a doc URL, e.g. `agents/harnesses/think.md`. */
export const itemKey = (url: string) =>
  `${new URL(url).pathname.replace(/^\/|\/index\.md$/g, "") || "agents"}.md`;

export const pageUrl = (url: string) => url.replace(/index\.md$/, "");

/**
 * Create the instance on first use, with the two metadata fields LazyDog cites.
 * Upload-based instances need no AI Search service token, unlike the CLI path.
 */
export async function ensureInstance(namespace: AiSearchNamespace, instance: string): Promise<"created" | "exists"> {
  try {
    await namespace.get(instance).info();
    return "exists";
  } catch (error) {
    if (!/not.?found/i.test(String((error as Error).message ?? error))) throw error;
  }
  await namespace.create({
    id: instance,
    custom_metadata: [
      { field_name: "title", data_type: "text" },
      { field_name: "url", data_type: "text" }
    ]
  });
  return "created";
}

export async function seedSearchBatch(
  namespace: AiSearchNamespace,
  instance: string,
  offset: number
): Promise<{
  instance?: "created" | "exists";
  uploaded: string[];
  failed: string[];
  total: number;
  nextOffset: number | null;
}> {
  const instanceStatus = offset === 0 ? await ensureInstance(namespace, instance) : undefined;
  const index = await (await fetch(DOCS_INDEX)).text();
  const urls = docUrlsFromIndex(index);
  const batch = urls.slice(offset, offset + BATCH_SIZE);
  const items = namespace.get(instance).items;
  const uploaded: string[] = [];
  const failed: string[] = [];

  for (const url of batch) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const { title, body } = cleanDocMarkdown(await res.text());
      await items.upload(itemKey(url), `# ${title}\n\nSource: ${pageUrl(url)}\n\n${body}`, {
        metadata: { title, url: pageUrl(url) }
      });
      uploaded.push(itemKey(url));
    } catch (error) {
      failed.push(`${itemKey(url)}: ${String((error as Error).message ?? error).slice(0, 120)}`);
    }
  }
  const next = offset + batch.length;
  return {
    ...(instanceStatus ? { instance: instanceStatus } : {}),
    uploaded,
    failed,
    total: urls.length,
    nextOffset: next < urls.length ? next : null
  };
}
