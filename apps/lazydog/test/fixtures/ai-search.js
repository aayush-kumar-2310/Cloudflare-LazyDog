// Test double for the AI Search namespace binding, served over Workers RPC.
// info() throws "not found" for a missing instance like the real API; workerd
// logs that as an uncaught exception in this fixture, which is expected.
// Mirrors the subset LazyDog uses: get(name).search/info/items, create().
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

const DOCS = [
  {
    key: "agents/runtime/execution/durable-execution.md",
    title: "Durable execution with fibers",
    url: "https://developers.cloudflare.com/agents/runtime/execution/durable-execution/",
    text: "runFiber registers a fiber in SQLite before it runs; ctx.stash checkpoints progress; onFiberRecovered resumes after eviction."
  },
  {
    key: "agents/runtime/execution/schedule-tasks.md",
    title: "Schedule tasks",
    url: "https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/",
    text: "this.schedule() persists delayed, dated and cron tasks backed by Durable Object alarms."
  }
];

const instances = new Map(); // name -> { items: Map<key, metadata> }

class Items extends RpcTarget {
  constructor(name) { super(); this.name = name; }
  async list(params = {}) {
    const items = [...(instances.get(this.name)?.items.values() ?? [])];
    const filtered = params.status && params.status !== "completed" ? [] : items;
    return { result: filtered.slice(0, params.per_page ?? 20), result_info: { total_count: filtered.length } };
  }
  async upload(name, _content, options = {}) {
    if (!instances.has(this.name)) throw new Error("AiSearchNotFoundError: ai_search_not_found");
    instances.get(this.name).items.set(name, { key: name, metadata: options.metadata ?? {} });
    return { id: name, key: name, status: "queued" };
  }
}

class Instance extends RpcTarget {
  constructor(name) { super(); this.name = name; }
  async info() {
    if (!instances.has(this.name) && this.name !== "lazydog-docs") throw new Error("AiSearchNotFoundError: ai_search_not_found");
    return { id: this.name };
  }
  async search(request) {
    const query = String(request.query ?? "").toLowerCase();
    const words = query.split(/\W+/).filter((w) => w.length > 3);
    const chunks = DOCS.map((d) => ({ d, score: words.filter((w) => (d.title + " " + d.text).toLowerCase().includes(w)).length / Math.max(1, words.length) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ d, score }) => ({ id: d.key, type: "text", score, text: d.text, item: { key: d.key, metadata: { title: d.title, url: d.url } } }));
    return { search_query: request.query, chunks };
  }
  get items() { return new Items(this.name); }
}

export default class AiSearchFixture extends WorkerEntrypoint {
  get(name) { return new Instance(name); }
  async create(config) {
    instances.set(config.id, { items: new Map(), config });
    return new Instance(config.id);
  }
  async __reset(name) { instances.delete(name); }
}
