import type { IggyControlPlane } from "./dispatcher.js";

export class IggyClient implements IggyControlPlane {
  private readonly baseUrl: URL;
  constructor(baseUrl: URL, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl.toString());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || token.length < 16) throw new Error("invalid_iggy_configuration");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
    this.baseUrl = url;
  }
  async startHealthRun(input: { id: string; capability: string }): Promise<void> {
    const body = JSON.stringify({ id: input.id, profile: "health-chat/v1", capability: input.capability });
    const response = await this.request("v1/runs", { method: "POST", headers: this.headers(), body });
    if (!response.ok) throw new Error("iggy_start_failed");
  }
  async cancelHealthRun(runId: string): Promise<void> {
    const response = await this.request(`v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers: this.headers() });
    if (!response.ok && response.status !== 404) throw new Error("iggy_cancel_failed");
  }
  async getHealthRunStatus(runId: string): Promise<"queued" | "running" | "completed" | "failed" | "cancelled"> {
    const response = await this.request(`v1/runs/${encodeURIComponent(runId)}`, { headers: this.headers() });
    if (!response.ok) throw new Error("iggy_status_failed");
    const body = await response.json() as { status?: unknown };
    if (body.status === "succeeded") return "completed";
    if (body.status === "provisioning" || body.status === "teardown") return "running";
    if (body.status === "queued" || body.status === "running" || body.status === "failed" || body.status === "cancelled") return body.status;
    throw new Error("iggy_unknown_status");
  }
  private headers(): Record<string, string> { return { authorization: `Bearer ${this.token}`, "content-type": "application/json" }; }
  private async request(path: string, init: RequestInit): Promise<Response> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try { response = await this.fetcher(new URL(path, this.baseUrl), { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) }); }
      catch {
        if (attempt === 2) throw new Error("iggy_request_failed");
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      if (response.status < 500 && response.status !== 429 && response.status !== 408) return response;
      lastStatus = response.status;
      if (attempt === 2) return response;
      await response.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
    throw new Error(lastStatus ? "iggy_request_failed" : "iggy_request_failed");
  }
}
