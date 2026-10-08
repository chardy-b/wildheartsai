import { ChatWebApi } from "./web-api.js";
import { IggyClient } from "./iggy-client.js";

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
  const maxTokens = Number.parseInt(env.CHAT_INFERENCE_MAX_TOKENS ?? "2048", 10);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error("invalid_chat_inference_max_tokens");
  return {
    api: new ChatWebApi({ baseUrl: requiredUrl(env, "CHAT_WEB_API_URL") }),
    inferenceUrl,
    modelId: required(env, "CHAT_INFERENCE_MODEL"),
    apiKey: env.CHAT_INFERENCE_API_KEY || undefined,
    maxTokens,
  };
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
