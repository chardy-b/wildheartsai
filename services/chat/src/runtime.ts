import { ChatWebApi } from "./web-api.js";
import { IggyClient } from "./iggy-client.js";
import { ResearchCorpus } from "./research-corpus.js";

type Environment = Readonly<Record<string, string | undefined>>;

export function createCoordinatorRuntime(env: Environment = process.env) {
  return {
    api: new ChatWebApi({ baseUrl: requiredUrl(env, "CHAT_WEB_API_URL"), coordinatorToken: required(env, "CHAT_COORDINATOR_TOKEN") }),
    iggy: new IggyClient(requiredUrl(env, "IGGY_URL"), required(env, "IGGY_BEARER_TOKEN")),
    workerId: required(env, "CHAT_WORKER_ID"),
  };
}

export function createGatewayRuntime(env: Environment = process.env) {
  const inferenceUrl = requiredUrl(env, "CHAT_INFERENCE_URL");
  if (!/^https?:$/.test(inferenceUrl.protocol) || inferenceUrl.username || inferenceUrl.password || inferenceUrl.search || inferenceUrl.hash) throw new Error("invalid_chat_inference_url");
  inferenceUrl.pathname = `${inferenceUrl.pathname.replace(/\/$/, "")}/`;
  const modelId = required(env, "CHAT_INFERENCE_MODEL");
  const maxTokens = Number.parseInt(env.CHAT_INFERENCE_MAX_TOKENS ?? "2048", 10);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error("invalid_chat_inference_max_tokens");
  const fallbackModelIds = parseFallbackModels(env.CHAT_INFERENCE_FALLBACK_MODELS, modelId);
  const attemptTimeoutMs = parseAttemptTimeout(env.CHAT_INFERENCE_ATTEMPT_TIMEOUT_MS);
  const researchRoot = env.CHAT_RESEARCH_CORPUS_ROOT?.trim();
  const researchToken = env.CHAT_RESEARCH_GATEWAY_TOKEN?.trim();
  if (researchToken && !/^[A-Za-z0-9_-]{43}$/.test(researchToken)) throw new Error("invalid_chat_research_gateway_token");
  return {
    api: new ChatWebApi({ baseUrl: requiredUrl(env, "CHAT_WEB_API_URL") }),
    inferenceUrl,
    modelId,
    apiKey: env.CHAT_INFERENCE_API_KEY || undefined,
    maxTokens,
    ...(fallbackModelIds ? { fallbackModelIds, attemptTimeoutMs } : {}),
    ...(researchRoot && researchToken ? { researchCorpus: new ResearchCorpus({ root: researchRoot }), researchGatewayToken: researchToken } : {}),
  };
}

function parseFallbackModels(value: string | undefined, primaryModel: string): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("invalid_chat_inference_fallback_models"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 3) throw new Error("invalid_chat_inference_fallback_models");
  const models: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(primaryModel)) throw new Error("invalid_chat_inference_fallback_models");
  const seen = new Set<string>([primaryModel]);
  for (const candidate of parsed) {
    if (typeof candidate !== "string") throw new Error("invalid_chat_inference_fallback_models");
    const model = candidate.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model) || seen.has(model)) throw new Error("invalid_chat_inference_fallback_models");
    seen.add(model);
    models.push(model);
  }
  return models;
}

function parseAttemptTimeout(value: string | undefined): number {
  const timeout = value === undefined || value.trim() === "" ? 45_000 : Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 120_000) throw new Error("invalid_chat_inference_attempt_timeout_ms");
  return timeout;
}

export function required(env: Environment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function requiredUrl(env: Environment, name: string): URL {
  try { return new URL(required(env, name)); }
  catch { throw new Error(`invalid_${name.toLowerCase()}`); }
}
