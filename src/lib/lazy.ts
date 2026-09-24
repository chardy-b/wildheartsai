// Defers creating a server singleton (database pool, auth instance) until it is
// first used, so `next build` can load route modules without runtime secrets.
// Methods are bound to the real instance so private class fields keep working.
export function lazy<T extends object>(create: () => T): T {
  let instance: T | undefined;
  const target = () => (instance ??= create());
  return new Proxy({} as T, {
    get(_placeholder, property) {
      const real = target();
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
    has(_placeholder, property) {
      return Reflect.has(target(), property);
    },
  });
}
