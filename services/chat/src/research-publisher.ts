import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ResearchCorpus, RESEARCH_LIMITS, RESEARCH_MANIFEST_FILENAME, RESEARCH_REPOSITORY } from "./research-corpus.js";

const allowedRoots = ["claims", "conditions", "institutions", "interventions", "mechanisms", "outcomes", "questions", "sources", "studies", "symptoms", "syntheses"] as const;
const markerName = ".wild-hearts-health-research-snapshot";
const markerContent = "managed-by-wild-hearts-research-publisher\n";
const stagePrefix = ".health-research-stage-";
const previousPrefix = ".health-research-previous-";
const maxPreviousSnapshots = 2;

type FileEntry = { path: string; bytes: number; sha256: string; content: Buffer };

/** Publish only curated Markdown and an engine-verified manifest into a managed destination. */
export async function publishResearchSnapshot(sourceArg: string, parentArg: string): Promise<{ snapshotId: string; files: number; bytes: number }> {
  if (!sourceArg || !parentArg) throw new Error("usage: research-publisher <source-repo> <published-parent>");
  const sourceRoot = await checkedDirectory(path.resolve(sourceArg));
  const parent = await checkedDirectory(path.resolve(parentArg));
  if (isWithin(sourceRoot, parent) || isWithin(parent, sourceRoot)) throw new Error("source_and_published_parent_must_be_separate");

  const files = await collectFiles(sourceRoot);
  if (!files.length) throw new Error("research_snapshot_empty");
  const declaredBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (declaredBytes > RESEARCH_LIMITS.maxTotalBytes) throw new Error("research_snapshot_too_large");

  const stage = await mkdtemp(path.join(parent, stagePrefix));
  let currentMoved = false;
  const current = path.join(parent, "current");
  const previous = path.join(parent, `${previousPrefix}${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID()}`);
  try {
    for (const entry of files) {
      const target = path.join(stage, ...entry.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.content, { flag: "wx" });
    }
    const manifest = {
      version: 1,
      repository: RESEARCH_REPOSITORY,
      files: files.map(({ path: relativePath, bytes, sha256 }) => ({ path: relativePath, bytes, sha256 })),
    };
    await writeFile(path.join(stage, RESEARCH_MANIFEST_FILENAME), JSON.stringify(manifest), { flag: "wx" });
    await writeFile(path.join(stage, markerName), markerContent, { flag: "wx" });

    // The real engine verifies allowlisted paths, strict frontmatter, unique record IDs,
    // per-file hashes, the aggregate limit and a stable content-derived snapshot ID.
    const validated = await new ResearchCorpus({ root: stage }).captureSnapshot();

    const existing = await maybeLstat(current);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory() || !(await hasPublisherMarker(current))) throw new Error("current_research_directory_not_managed");
      await rename(current, previous);
      currentMoved = true;
    }
    try {
      await rename(stage, current);
    } catch (error) {
      if (currentMoved) {
        await rename(previous, current).catch(() => undefined);
        currentMoved = false;
      }
      throw error;
    }
    await retainPreviousSnapshots(parent);
    return { snapshotId: validated.snapshotId, files: files.length, bytes: declaredBytes };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function collectFiles(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  let totalBytes = 0;
  const addFile = async (relativePath: string): Promise<void> => {
    if (relativePath.length > 500 || relativePath.split("/").length > RESEARCH_LIMITS.maxPathDepth) throw new Error("research_path_too_deep");
    const absolute = path.join(root, ...relativePath.split("/"));
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > RESEARCH_LIMITS.maxFileBytes) throw new Error("research_file_invalid");
    const canonicalBefore = await realpath(absolute);
    if (!isWithin(root, canonicalBefore) || canonicalBefore === root) throw new Error("research_path_escape");
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let content: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.size > RESEARCH_LIMITS.maxFileBytes) throw new Error("research_file_changed");
      content = Buffer.alloc(opened.size);
      let bytesRead = 0;
      while (bytesRead < content.byteLength) {
        const chunk = await handle.read(content, bytesRead, content.byteLength - bytesRead, bytesRead);
        if (!chunk.bytesRead) throw new Error("research_file_changed");
        bytesRead += chunk.bytesRead;
      }
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) throw new Error("research_file_changed");
      if (await realpath(absolute) !== canonicalBefore) throw new Error("research_path_changed");
    } finally { await handle.close(); }
    totalBytes += content.byteLength;
    if (files.length + 1 > RESEARCH_LIMITS.maxFiles || totalBytes > RESEARCH_LIMITS.maxTotalBytes) throw new Error("research_snapshot_too_large");
    files.push({ path: relativePath, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex"), content });
  };

  const indexPath = path.join(root, "index.md");
  const index = await maybeLstat(indexPath);
  if (index) await addFile("index.md");

  for (const rootName of allowedRoots) {
    const top = path.join(root, rootName);
    const topStat = await maybeLstat(top);
    if (!topStat) continue;
    if (topStat.isSymbolicLink() || !topStat.isDirectory()) throw new Error("research_directory_invalid");
    await walk(top, rootName, 1, addFile);
  }
  files.sort((a, b) => comparePath(a.path, b.path));
  return files;
}

async function walk(directory: string, relativeDirectory: string, depth: number, addFile: (relativePath: string) => Promise<void>): Promise<void> {
  if (depth > RESEARCH_LIMITS.maxPathDepth) throw new Error("research_path_too_deep");
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => comparePath(a.name, b.name));
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error("research_symlink_rejected");
    if (stat.isDirectory()) {
      await walk(absolute, relativePath, depth + 1, addFile);
      continue;
    }
    if (!stat.isFile()) continue;
    if (/^(?:agents|claude|readme)\.md$/i.test(entry.name)) continue;
    if (entry.name.endsWith(".md")) await addFile(relativePath);
  }
}

async function retainPreviousSnapshots(parent: string): Promise<void> {
  const candidates: Array<{ path: string; name: string }> = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!new RegExp(`^${escapeRegex(previousPrefix)}\\d{17}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(entry.name)) continue;
    const candidate = path.join(parent, entry.name);
    const stat = await lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !(await hasPublisherMarker(candidate))) continue;
    candidates.push({ path: candidate, name: entry.name });
  }
  candidates.sort((a, b) => comparePath(b.name, a.name));
  for (const item of candidates.slice(maxPreviousSnapshots)) await rm(item.path, { recursive: true, force: true });
}

async function checkedDirectory(value: string): Promise<string> {
  const stat = await lstat(value);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("research_directory_invalid");
  return realpath(value);
}

async function maybeLstat(value: string) {
  try { return await lstat(value); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function hasPublisherMarker(directory: string): Promise<boolean> {
  try {
    const markerPath = path.join(directory, markerName);
    const marker = await lstat(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink() || marker.size > Buffer.byteLength(markerContent)) return false;
    const handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== marker.dev || opened.ino !== marker.ino || opened.size !== marker.size) return false;
      const bytes = Buffer.alloc(opened.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return bytesRead === bytes.length && bytes.toString("utf8") === markerContent;
    } finally { await handle.close(); }
  } catch { return false; }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function comparePath(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await publishResearchSnapshot(process.argv[2] ?? "", process.argv[3] ?? "");
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write("research_snapshot_publish_failed\n");
    process.exitCode = 1;
  }
}
