// Copies the PDF viewer's worker, character maps and standard fonts into public/pdfjs, so they're
// served as static files on Vercel and Cloudflare alike (no route reading node_modules at request
// time, which a Worker can't). Runs after every install; public/pdfjs is git-ignored.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const target = join(process.cwd(), "public", "pdfjs");
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, "build"), { recursive: true });
cpSync(join(root, "build", "pdf.worker.min.mjs"), join(target, "build", "pdf.worker.min.mjs"));
for (const directory of ["cmaps", "standard_fonts"]) cpSync(join(root, directory), join(target, directory), { recursive: true });
if (!existsSync(join(target, "build", "pdf.worker.min.mjs"))) throw new Error("pdf.js assets were not copied");
