// Content-Security-Policy for every page. Scripts run only from this origin with the
// per-request nonce Next.js adds to its own scripts ('strict-dynamic' lets those load
// the rest), so injected markup can't run script even if some ever reached a page.
// Pages must render per request for the nonce to apply (see src/app/layout.tsx).

export function createNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function contentSecurityPolicy(nonce: string, options: { development: boolean; https: boolean }): string {
  return [
    "default-src 'self'",
    // React needs eval in development only, to rebuild server error stacks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes (the landing page animation) are allowed; styles can't run script.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
