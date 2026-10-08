import { describe, expect, it } from "vitest";
import { createCoordinatorRuntime, createGatewayRuntime } from "../src/runtime.js";

describe("remote-only runtime configuration", () => {
  it("starts coordinator and gateway adapters without database or record-key settings", () => {
    const coordinator = createCoordinatorRuntime({
      CHAT_WEB_API_URL: "https://www.wildheartsai.com/api/chat/worker/v1",
      CHAT_COORDINATOR_TOKEN: "synthetic-coordinator-token-with-enough-length",
      CHAT_WORKER_ID: "worker-test",
      IGGY_URL: "http://127.0.0.1:8417",
      IGGY_BEARER_TOKEN: "synthetic-iggy-management-token",
    });
    const gateway = createGatewayRuntime({
      CHAT_WEB_API_URL: "https://www.wildheartsai.com/api/chat/worker/v1",
      CHAT_INFERENCE_URL: "http://127.0.0.1:8081/v1",
      CHAT_INFERENCE_MODEL: "synthetic-model",
      CHAT_INFERENCE_MAX_TOKENS: "1024",
    });
    expect(coordinator.workerId).toBe("worker-test");
    expect(gateway.modelId).toBe("synthetic-model");
    expect(gateway.maxTokens).toBe(1024);
    expect(Object.keys(coordinator)).toEqual(["api", "iggy", "workerId"]);
    expect(Object.keys(gateway)).toEqual(["api", "inferenceUrl", "modelId", "apiKey", "maxTokens"]);
  });

  it("rejects unsafe authority and inference URLs", () => {
    expect(() => createCoordinatorRuntime({
      CHAT_WEB_API_URL: "https://www.wildheartsai.com/api/chat/worker/v1?next=http://attacker.test",
      CHAT_COORDINATOR_TOKEN: "synthetic-coordinator-token-with-enough-length",
      CHAT_WORKER_ID: "worker-test",
      IGGY_URL: "http://127.0.0.1:8417",
      IGGY_BEARER_TOKEN: "synthetic-iggy-management-token",
    })).toThrow("invalid_chat_web_api_url");
    expect(() => createGatewayRuntime({
      CHAT_WEB_API_URL: "https://www.wildheartsai.com/api/chat/worker/v1",
      CHAT_INFERENCE_URL: "http://user:password@model.internal/v1",
      CHAT_INFERENCE_MODEL: "synthetic-model",
    })).toThrow("invalid_chat_inference_url");
  });

  it("enables research only when both gateway-only settings are present", () => {
    const token = "r".repeat(43);
    const disabled = createGatewayRuntime({
      CHAT_WEB_API_URL: "https://www.wildheartsai.com/api/chat/worker/v1",
      CHAT_INFERENCE_URL: "http://127.0.0.1:8081/v1",
      CHAT_INFERENCE_MODEL: "synthetic-model",
      CHAT_RESEARCH_CORPUS_ROOT: "/srv/research/current",
    });
    expect(disabled).not.toHaveProperty("researchCorpus");
    expect(disabled).not.toHaveProperty("researchGatewayToken");

    const enabled = createGatewayRuntime({
      CHAT_WEB_API_URL: "https://www.wildheartsai.com/api/chat/worker/v1",
      CHAT_INFERENCE_URL: "http://127.0.0.1:8081/v1",
      CHAT_INFERENCE_MODEL: "synthetic-model",
      CHAT_RESEARCH_CORPUS_ROOT: "/srv/research/current",
      CHAT_RESEARCH_GATEWAY_TOKEN: token,
    });
    expect(enabled.researchGatewayToken).toBe(token);
    expect(enabled.researchCorpus).toBeDefined();
    expect(createCoordinatorRuntime({
      CHAT_WEB_API_URL: "https://www.wildheartsai.com/api/chat/worker/v1",
      CHAT_COORDINATOR_TOKEN: "synthetic-coordinator-token-with-enough-length",
      CHAT_WORKER_ID: "worker-test",
      IGGY_URL: "http://127.0.0.1:8417",
      IGGY_BEARER_TOKEN: "synthetic-iggy-management-token",
      CHAT_RESEARCH_GATEWAY_TOKEN: token,
      CHAT_RESEARCH_CORPUS_ROOT: "/srv/research/current",
    })).not.toHaveProperty("researchGatewayToken");
  });
});
