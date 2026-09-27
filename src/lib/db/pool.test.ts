import { describe, expect, it } from "vitest";
import { poolOptions } from "./index";

describe("poolOptions", () => {
  it("keeps the local database's pool small, and leaves hosted databases alone", () => {
    expect(poolOptions("postgres://postgres:postgres@127.0.0.1:5433/postgres")).toEqual({ max: 2, idleTimeoutMillis: 2000 });
    expect(poolOptions("postgres://postgres@localhost:5433/postgres")).toMatchObject({ max: 2 });
    expect(poolOptions("postgresql://user:pass@ep-example.neon.tech/neondb?sslmode=require")).toEqual({ max: 5 });
  });
});
