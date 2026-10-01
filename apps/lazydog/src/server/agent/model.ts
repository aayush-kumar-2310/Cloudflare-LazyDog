import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { config } from "../config";
import { createMockModel } from "./mock-model";

const DEFAULT_MODELS = {
  "workers-ai": "@cf/qwen/qwen3.8-27b",
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.1"
} as const;

/**
 * The model is chosen by MODEL_PROVIDER / MODEL_ID. Workers AI needs no key;
 * external providers fall back to Workers AI when their key is missing so a
 * misconfigured deploy still answers instead of failing every turn.
 */
export function createModel(env: Env): { model: LanguageModel; label: string } {
  const c = config(env);
  if (c.modelProvider === "mock" && c.allowMockModel) {
    return { model: createMockModel(), label: "mock/scripted" };
  }
  if (c.modelProvider === "anthropic" && c.anthropicApiKey) {
    const id = c.modelId || DEFAULT_MODELS.anthropic;
    return { model: createAnthropic({ apiKey: c.anthropicApiKey })(id), label: `anthropic/${id}` };
  }
  if (c.modelProvider === "openai" && c.openaiApiKey) {
    const id = c.modelId || DEFAULT_MODELS.openai;
    return { model: createOpenAI({ apiKey: c.openaiApiKey })(id), label: `openai/${id}` };
  }
  const id =
    c.modelProvider === "workers-ai" && c.modelId ? c.modelId : DEFAULT_MODELS["workers-ai"];
  return {
    model: createWorkersAI({ binding: env.AI })(id as Parameters<ReturnType<typeof createWorkersAI>>[0]),
    label: `workers-ai/${id}`
  };
}
