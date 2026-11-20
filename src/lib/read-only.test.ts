import { afterEach, describe, expect, it, vi } from "vitest";
import { assertWritable, READ_ONLY_MESSAGE } from "./read-only";

describe("assertWritable", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses only in read-only mode", () => {
    expect(() => assertWritable()).not.toThrow();
    vi.stubEnv("MAINTENANCE_READ_ONLY", "1");
    expect(() => assertWritable()).toThrow(READ_ONLY_MESSAGE);
  });
});

// The server actions check it themselves, not only the proxy.
describe("server actions in read-only mode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuse before touching anything", async () => {
    vi.stubEnv("MAINTENANCE_READ_ONLY", "1");
    const connections = await import("@/app/(app)/app/connections/actions");
    const onboarding = await import("@/app/(app)/app/onboarding/actions");
    const form = new FormData();
    for (const action of [connections.disconnectAction, connections.refreshAction, connections.deleteSourceAction, connections.connectMetriportSandboxAction]) await expect(action(form)).rejects.toThrow(READ_ONLY_MESSAGE);
    await expect(connections.refreshAllAction()).rejects.toThrow(READ_ONLY_MESSAGE);
    await expect(onboarding.saveNameAction({}, form)).rejects.toThrow(READ_ONLY_MESSAGE);
    await expect(onboarding.finishOnboardingAction()).rejects.toThrow(READ_ONLY_MESSAGE);
  });
});
