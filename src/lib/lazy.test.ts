import { describe, expect, it, vi } from "vitest";
import { lazy } from "./lazy";

class Counter {
  #count = 0;
  label = "counter";
  increment() {
    this.#count += 1;
    return this.#count;
  }
}

describe("lazy", () => {
  it("does not create the instance until it is first used", () => {
    const create = vi.fn(() => new Counter());
    const counter = lazy(create);
    expect(create).not.toHaveBeenCalled();
    expect(counter.label).toBe("counter");
    expect(create).toHaveBeenCalledOnce();
  });

  it("creates the instance once and binds methods to it, private fields included", () => {
    const create = vi.fn(() => new Counter());
    const counter = lazy(create);
    const { increment } = counter;
    expect(counter.increment()).toBe(1);
    expect(increment()).toBe(2);
    expect(create).toHaveBeenCalledOnce();
  });

  it("supports the `in` operator", () => {
    expect("increment" in lazy(() => new Counter())).toBe(true);
  });
});
