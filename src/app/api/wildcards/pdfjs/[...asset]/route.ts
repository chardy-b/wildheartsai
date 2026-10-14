import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";

// Public library assets only. Uploaded files never pass through this route.
export async function GET(_request: Request, context: { params: Promise<{ asset: string[] }> }) {
  const { asset } = await context.params;
  const [directory, name] = asset;
  const allowed = asset.length === 2 && /^[a-zA-Z0-9_.-]+$/.test(name) && (
    (directory === "build" && name === "pdf.worker.min.mjs") ||
    (directory === "cmaps" && name.endsWith(".bcmap")) ||
    (directory === "standard_fonts" && /\.(pfb|ttf)$/.test(name))
  );
  if (!allowed) return new Response(null, { status: 404 });
  try {
    const bytes = await readFile(join(process.cwd(), "node_modules/pdfjs-dist", directory, name));
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": directory === "build" ? "text/javascript; charset=utf-8" : "application/octet-stream",
      "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff",
    } });
  } catch { return new Response(null, { status: 404 }); }
}
