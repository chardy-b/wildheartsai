import type { IggyControlPlane } from "./dispatcher.js";

export class IggyClient implements IggyControlPlane {
  constructor(private readonly baseUrl: URL, private readonly token: string) {}
  async startHealthRun(input: { id: string; capability: string }): Promise<void> {
    const response = await fetch(new URL("/v1/runs", this.baseUrl), { method: "POST", headers: this.headers(), body: JSON.stringify({ id: input.id, profile: "health-chat/v1", capability: input.capability }), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("iggy_start_failed");
  }
  async cancelHealthRun(runId: string): Promise<void> {
    const response = await fetch(new URL(`/v1/runs/${encodeURIComponent(runId)}/cancel`, this.baseUrl), { method: "POST", headers: this.headers(), signal: AbortSignal.timeout(5_000) });
    if (!response.ok && response.status !== 404) throw new Error("iggy_cancel_failed");
  }
  async getHealthRunStatus(runId: string): Promise<"queued" | "running" | "completed" | "failed" | "cancelled"> {
    const response = await fetch(new URL(`/v1/runs/${encodeURIComponent(runId)}`, this.baseUrl), { headers: this.headers(), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("iggy_status_failed");
    const body = await response.json() as { status?: unknown };
    if (body.status === "succeeded") return "completed";
    if (body.status === "provisioning" || body.status === "teardown") return "running";
    if (body.status === "queued" || body.status === "running" || body.status === "failed" || body.status === "cancelled") return body.status;
    throw new Error("iggy_unknown_status");
  }
  private headers(): Record<string, string> { return { authorization: `Bearer ${this.token}`, "content-type": "application/json" }; }
}
