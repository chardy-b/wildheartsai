import type { NextConfig } from "next";

const securityHeaders = [
  // Browsers ignore this over plain http, so it has no effect locally.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

// The Content-Security-Policy is set per request in src/proxy.ts, since it carries a nonce.
const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/wildcards/pdfjs/[...asset]": ["./node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "./node_modules/pdfjs-dist/cmaps/**/*", "./node_modules/pdfjs-dist/standard_fonts/**/*"],
  },
  // The public demo lives on the homepage; the signed-in guided entry is /demo/guided.
  async redirects() {
    return [{ source: "/demo", destination: "/#demo", permanent: false }];
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
