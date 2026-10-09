import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pool: vi.fn(), end: vi.fn(), preflight: vi.fn(), authority: vi.fn() }));
vi.mock("pg", () => ({ Pool: class { constructor(options: unknown) { mocks.pool(options); } end = mocks.end; on() { return this; } } }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => ({}) }));
vi.mock("./role-preflight", () => ({ assertChatDatabaseRoles: mocks.preflight }));
vi.mock("./authority", () => ({ ChatAuthority: class { constructor(options: unknown) { mocks.authority(options); } } }));

let diagnostic: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.preflight.mockResolvedValue(undefined); mocks.end.mockResolvedValue(undefined);
  diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("CHAT_ENABLED", "1");
  vi.stubEnv("CHAT_RESEARCH_GATEWAY_TOKEN_HASH", "");
  vi.stubEnv("CHAT_DATABASE_URL", "postgres://synthetic_data:db-secret@localhost/test");
  vi.stubEnv("CHAT_QUEUE_DATABASE_URL", "postgres://synthetic_queue:queue-secret@localhost/test");
  vi.stubEnv("CHAT_GRANT_DERIVATION_KEY", Buffer.alloc(32, 8).toString("base64url"));
  vi.stubEnv("RECORDS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("CHAT_INFERENCE_MODEL", "synthetic-model");
});
afterEach(() => { diagnostic.mockRestore(); vi.unstubAllEnvs(); });

describe("lazy fail-closed web chat configuration", () => {
  it("opens no pools at import or when disabled", async () => {
    vi.stubEnv("CHAT_ENABLED", "0");
    const runtime = await import("./runtime");
    expect(mocks.pool).not.toHaveBeenCalled();
    await expect(runtime.webChatRuntime()).rejects.toThrow("chat_unavailable");
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(diagnostic).not.toHaveBeenCalled();
  });
  it("rejects missing or malformed authority configuration without opening pools and logs only a fixed config code", async () => {
    const runtime = await import("./runtime");
    vi.stubEnv("CHAT_GRANT_DERIVATION_KEY", `${Buffer.alloc(32, 8).toString("base64url")}!`);
    await expect(runtime.webChatRuntime()).rejects.toThrow("chat_unavailable");
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith("chat_runtime_initialization_failed phase=validate_config code=INVALID_CHAT_GRANT_DERIVATION_KEY");
    diagnostic.mockClear();
    vi.stubEnv("CHAT_GRANT_DERIVATION_KEY", Buffer.alloc(32, 8).toString("base64url"));
    vi.stubEnv("CHAT_DATABASE_URL", "");
    await expect(runtime.webChatRuntime()).rejects.toThrow("chat_unavailable");
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith("chat_runtime_initialization_failed phase=validate_config code=MISSING_CHAT_DATABASE_URL");
  });
  it("shares initialization across simultaneous callers and verifies restricted roles", async () => {
    const runtime = await import("./runtime");
    const [one, two] = await Promise.all([runtime.webChatRuntime(), runtime.webChatRuntime()]);
    expect(one).toBe(two);
    expect(mocks.pool).toHaveBeenCalledTimes(2);
    expect(mocks.preflight).toHaveBeenCalledTimes(1);
    expect(mocks.authority).toHaveBeenCalledTimes(1);
    expect(diagnostic).not.toHaveBeenCalled();
  });
  it("logs allowlisted database codes and fixed preflight labels", async () => {
    mocks.preflight.mockRejectedValueOnce(Object.assign(new Error("driver detail with credential canary"), { code: "28P01" }));
    const runtime = await import("./runtime");
    await expect(runtime.webChatRuntime()).rejects.toThrow(/^chat_unavailable$/);
    expect(diagnostic).toHaveBeenCalledWith("chat_runtime_initialization_failed phase=connect_role_preflight code=28P01");
    diagnostic.mockClear();
    mocks.preflight.mockRejectedValueOnce(new Error("chat_role_has_memberships"));
    await expect(runtime.webChatRuntime()).rejects.toThrow(/^chat_unavailable$/);
    expect(diagnostic).toHaveBeenCalledWith("chat_runtime_initialization_failed phase=connect_role_preflight code=CHAT_ROLE_HAS_MEMBERSHIPS");
  });
  it("never logs arbitrary error, stack, cause, or code content", async () => {
    const canary = "sensitive-canary-postgres://user:password@host/patient-id";
    const cause = Object.assign(new Error(`cause ${canary}`), { code: canary });
    const error = Object.assign(new Error(`message ${canary}`, { cause }), { code: canary });
    mocks.preflight.mockRejectedValueOnce(error);
    const runtime = await import("./runtime");
    await expect(runtime.webChatRuntime()).rejects.toThrow(/^chat_unavailable$/);
    expect(diagnostic).toHaveBeenCalledWith("chat_runtime_initialization_failed phase=connect_role_preflight code=UNKNOWN");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(canary);
  });
  it("closes failed pools, hides underlying errors, and permits a clean retry", async () => {
    mocks.preflight.mockRejectedValueOnce(new Error("synthetic-secret-in-driver-error"));
    const runtime = await import("./runtime");
    await expect(runtime.webChatRuntime()).rejects.toThrow(/^chat_unavailable$/);
    expect(mocks.end).toHaveBeenCalledTimes(2);
    await runtime.webChatRuntime();
    expect(mocks.pool).toHaveBeenCalledTimes(4);
  });
  it("reports authority construction failures with a fixed phase and still permits retry", async () => {
    mocks.authority.mockImplementationOnce(() => { throw new Error("authority-secret-canary"); });
    const runtime = await import("./runtime");
    await expect(runtime.webChatRuntime()).rejects.toThrow(/^chat_unavailable$/);
    expect(diagnostic).toHaveBeenCalledWith("chat_runtime_initialization_failed phase=construct_authority code=UNKNOWN");
    expect(mocks.end).toHaveBeenCalledTimes(2);
    await runtime.webChatRuntime();
    expect(mocks.authority).toHaveBeenCalledTimes(2);
  });  it("passes only an optional research verifier and never requires a VPS raw token", async () => {
    vi.stubEnv("CHAT_RESEARCH_GATEWAY_TOKEN_HASH", "a".repeat(64));
    const runtime = await import("./runtime"); await runtime.webChatRuntime();
    expect(mocks.authority).toHaveBeenCalledWith(expect.objectContaining({ researchGatewayTokenHash: "a".repeat(64) }));
    expect(mocks.authority.mock.calls[0][0]).not.toHaveProperty("researchGatewayToken");
  });
});
