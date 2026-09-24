// Inspect path syntax before URL parsing. WHATWG URL canonicalization removes
// literal and percent-encoded dot segments and converts backslashes to slashes.
export function hasUnsafePathSyntax(value: string): boolean {
  const candidate = value.trim();
  if (candidate.includes("\\")) return true;

  const beforeQueryOrFragment = candidate.split(/[?#]/, 1)[0];
  const absolute = beforeQueryOrFragment.match(/^[a-z][a-z\d+.-]*:\/\/[^/]*(\/.*)?$/i);
  const pathname = absolute ? (absolute[1] ?? "") : beforeQueryOrFragment;

  return (
    /%(?:2e|2f|5c|25)/i.test(pathname) ||
    pathname.split("/").some((segment) => segment === "." || segment === "..")
  );
}
