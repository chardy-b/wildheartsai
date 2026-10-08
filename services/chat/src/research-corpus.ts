import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const RESEARCH_REPOSITORY = "bernert/health-research-wiki" as const;
export const RESEARCH_MANIFEST_FILENAME = "snapshot-manifest.json" as const;

export const RESEARCH_LIMITS = {
  maxFiles: 2_000,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxPathDepth: 6,
  maxManifestBytes: 1024 * 1024,
  maxQueryChars: 200,
  maxResults: 5,
  defaultResults: 5,
  maxExcerptChars: 800,
  maxReadChars: 12_000,
  maxSnapshots: 2,
} as const;
const MAX_TOOL_RESULT_BYTES = 32 * 1024;

const allowedRoots = new Set([
  "claims", "conditions", "institutions", "interventions", "mechanisms", "outcomes",
  "questions", "sources", "studies", "symptoms", "syntheses",
]);

const stableIdPattern = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

const manifestEntrySchema = z.object({
  path: z.string().min(1).max(500),
  sha256: z.string().regex(sha256Pattern),
  bytes: z.number().int().nonnegative().max(RESEARCH_LIMITS.maxFileBytes),
}).strict();

const snapshotManifestSchema = z.object({
  version: z.literal(1),
  repository: z.literal(RESEARCH_REPOSITORY),
  commit: z.string().regex(commitPattern).nullable().optional(),
  files: z.array(manifestEntrySchema).min(1).max(RESEARCH_LIMITS.maxFiles),
}).strict();

const frontmatterSchema = z.object({
  id: z.string().min(1).max(128).regex(stableIdPattern),
  record_type: z.string().min(1).max(48).regex(/^[a-z][a-z0-9_-]*$/),
  title: z.string().trim().min(1).max(300),
  source_ids: z.array(z.string().min(1).max(128).regex(stableIdPattern)).max(100).optional(),
}).passthrough();

const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(RESEARCH_LIMITS.maxQueryChars),
  limit: z.number().int().min(1).max(RESEARCH_LIMITS.maxResults).optional(),
}).strict();

const readInputSchema = z.object({
  sourceId: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().nonnegative().max(10_000_000).optional(),
  limit: z.number().int().min(1).max(RESEARCH_LIMITS.maxReadChars).optional(),
}).strict();

export type ResearchSearchHit = Readonly<{
  sourceId: string;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  truncated: boolean;
}>;

export type ResearchSearchResult = Readonly<{
  snapshotId: string;
  hits: readonly ResearchSearchHit[];
  truncated: boolean;
}>;

export type ResearchReadResult = Readonly<{
  snapshotId: string;
  sourceId: string;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  offset: number;
  nextOffset: number | null;
  totalChars: number;
  truncated: boolean;
}>;

export type ResearchSnapshotInfo = Readonly<{ snapshotId: string }>;

type SnapshotDocument = Readonly<{
  sourceId: string;
  recordId: string;
  path: string;
  sourceIds: readonly string[];
  title: string;
  recordType: string;
  text: string;
  contentSha256: string;
  bodyStartLine: number;
  totalChars: number;
}>;

type LoadedSnapshot = Readonly<{
  info: ResearchSnapshotInfo;
  provenance: Readonly<{ commit: string | null; documentCount: number; totalBytes: number }>;
  documents: readonly SnapshotDocument[];
  byId: ReadonlyMap<string, SnapshotDocument>;
}>;

export type ResearchCorpusOptions = Readonly<{
  /** Trusted operator configuration. Never accept this value from a tool/model request. */
  root: string;
}>;

export class ResearchCorpusError extends Error {
  constructor(readonly code: "unavailable" | "invalid_snapshot" | "invalid_request" | "not_found") {
    super(code);
    this.name = "ResearchCorpusError";
  }
}

/** Loads and searches only an operator-configured local snapshot; it never follows wiki links. */
export class ResearchCorpus {
  private readonly snapshots = new Map<string, LoadedSnapshot>();
  private currentSnapshotId: string | undefined;
  private currentManifestSha256: string | undefined;
  private capturePromise: Promise<ResearchSnapshotInfo> | undefined;

  constructor(private readonly options: ResearchCorpusOptions) {
    if (!options.root.trim()) throw new ResearchCorpusError("invalid_snapshot");
  }

  async captureSnapshot(): Promise<ResearchSnapshotInfo> {
    if (this.capturePromise) return this.capturePromise;
    const capture = (async () => {
      const root = await configuredRoot(this.options.root);
      const manifest = await readManifest(root);
      if (manifest.sha256 === this.currentManifestSha256 && this.currentSnapshotId) {
        const current = this.snapshots.get(this.currentSnapshotId);
        if (current) return current.info;
      }

      const candidate = await loadSnapshot(root, manifest);
      const previous = this.snapshots.get(candidate.info.snapshotId);
      const snapshot = previous?.provenance.commit === candidate.provenance.commit ? previous : candidate;
      this.snapshots.delete(snapshot.info.snapshotId);
      this.snapshots.set(snapshot.info.snapshotId, snapshot);
      while (this.snapshots.size > RESEARCH_LIMITS.maxSnapshots) {
        const oldest = this.snapshots.keys().next().value as string | undefined;
        if (!oldest) break;
        this.snapshots.delete(oldest);
      }
      this.currentSnapshotId = snapshot.info.snapshotId;
      this.currentManifestSha256 = manifest.sha256;
      return snapshot.info;
    })().finally(() => {
      if (this.capturePromise === capture) this.capturePromise = undefined;
    });
    this.capturePromise = capture;
    return capture;
  }

  search(snapshotId: unknown, rawInput: unknown): ResearchSearchResult {
    const snapshot = this.snapshot(snapshotId);
    const parsed = searchInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ResearchCorpusError("invalid_request");
    const queryTerms = tokenize(parsed.data.query);
    if (!queryTerms.length) throw new ResearchCorpusError("invalid_request");
    const normalizedQuery = normalize(parsed.data.query);
    const limit = parsed.data.limit ?? RESEARCH_LIMITS.defaultResults;
    const matches: Array<{ document: SnapshotDocument; score: number }> = [];

    for (const document of snapshot.documents) {
      const normalizedTitle = normalize(document.title);
      const normalizedText = normalize(document.text);
      let score = 0;
      for (const term of queryTerms) {
        const titleMatches = countOccurrences(normalizedTitle, term);
        const bodyMatches = countOccurrences(normalizedText, term);
        if (titleMatches) score += 8 + Math.min(titleMatches - 1, 3);
        if (bodyMatches) score += Math.min(bodyMatches, 8);
      }
      if (!score) continue;
      if (normalizedQuery.length > 1 && normalizedTitle.includes(normalizedQuery)) score += 16;
      else if (normalizedQuery.length > 1 && normalizedText.includes(normalizedQuery)) score += 4;
      matches.push({ document, score });
    }

    matches.sort((a, b) => b.score - a.score || a.document.path.localeCompare(b.document.path));
    const hits = matches.slice(0, limit).map(({ document }) => {
      const snippet = makeExcerpt(document, queryTerms);
      const excerptChars = Array.from(snippet.text).length;
      const lines = lineRange(document, snippet.offset, excerptChars);
      return {
        sourceId: document.sourceId,
        title: document.title,
        path: document.path,
        startLine: lines.startLine,
        endLine: lines.endLine,
        excerpt: snippet.text,
        offset: snippet.offset,
        nextOffset: snippet.offset + excerptChars < document.totalChars ? snippet.offset + excerptChars : null,
        totalChars: document.totalChars,
        truncated: snippet.offset > 0 || snippet.offset + excerptChars < document.totalChars,
      };
    });
    return boundSearchOutput(snapshot.info.snapshotId, hits, matches.length > hits.length, snapshot.documents);
  }

  read(snapshotId: unknown, rawInput: unknown): ResearchReadResult {
    const snapshot = this.snapshot(snapshotId);
    const parsed = readInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ResearchCorpusError("invalid_request");
    const document = snapshot.byId.get(parsed.data.sourceId);
    if (!document) throw new ResearchCorpusError("not_found");
    const points = Array.from(document.text);
    const offset = parsed.data.offset ?? 0;
    if (offset > points.length) throw new ResearchCorpusError("invalid_request");
    const limit = parsed.data.limit ?? RESEARCH_LIMITS.maxReadChars;
    let end = offset;
    let codeUnits = 0;
    const requestedEnd = Math.min(points.length, offset + limit);
    while (end < requestedEnd && codeUnits + points[end]!.length <= RESEARCH_LIMITS.maxReadChars) {
      codeUnits += points[end]!.length;
      end += 1;
    }
    let result = makeReadResult(snapshot.info.snapshotId, document, points, offset, end);
    if (jsonBytes(result) > MAX_TOOL_RESULT_BYTES) {
      let low = offset + 1;
      let high = end;
      let best = offset;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = makeReadResult(snapshot.info.snapshotId, document, points, offset, middle);
        if (jsonBytes(candidate) <= MAX_TOOL_RESULT_BYTES) { best = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (best === offset) throw new ResearchCorpusError("invalid_snapshot");
      result = makeReadResult(snapshot.info.snapshotId, document, points, offset, best);
    }
    return result;
  }

  private snapshot(snapshotId: unknown): LoadedSnapshot {
    if (typeof snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(snapshotId)) throw new ResearchCorpusError("invalid_request");
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new ResearchCorpusError("not_found");
    return snapshot;
  }
}

type ReadManifest = { value: z.infer<typeof snapshotManifestSchema>; sha256: string };

async function configuredRoot(configuredRootPath: string): Promise<string> {
  try {
    const absolute = path.resolve(configuredRootPath);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ResearchCorpusError("invalid_snapshot");
    return await realpath(absolute);
  } catch (error) {
    if (error instanceof ResearchCorpusError) throw error;
    throw new ResearchCorpusError("unavailable");
  }
}

async function readManifest(root: string): Promise<ReadManifest> {
  try {
    const bytes = await readRegularFile(root, path.join(root, RESEARCH_MANIFEST_FILENAME), RESEARCH_LIMITS.maxManifestBytes);
    const text = decodeUtf8(bytes);
    const parsed = snapshotManifestSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) throw new ResearchCorpusError("invalid_snapshot");
    return { value: parsed.data, sha256: hash(bytes) };
  } catch (error) {
    if (error instanceof ResearchCorpusError) throw error;
    throw new ResearchCorpusError("invalid_snapshot");
  }
}

async function loadSnapshot(root: string, manifestRead: ReadManifest): Promise<LoadedSnapshot> {
  try {
    const manifest = manifestRead.value;
    const totalDeclared = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    if (totalDeclared > RESEARCH_LIMITS.maxTotalBytes) throw new ResearchCorpusError("invalid_snapshot");

    const entries = [...manifest.files].sort((a, b) => comparePath(a.path, b.path));
    const seenPaths = new Set<string>();
    const seenRecordIds = new Set<string>();
    const documents: SnapshotDocument[] = [];
    let totalBytes = 0;
    const snapshotDigest = createHash("sha256").update(`${RESEARCH_REPOSITORY}\n`);
    for (const entry of entries) {
      validateManifestPath(entry.path);
      if (seenPaths.has(entry.path)) throw new ResearchCorpusError("invalid_snapshot");
      seenPaths.add(entry.path);
      const filePath = path.join(root, ...entry.path.split("/"));
      const bytes = await readRegularFile(root, filePath, RESEARCH_LIMITS.maxFileBytes);
      if (bytes.byteLength !== entry.bytes || hash(bytes) !== entry.sha256.toLowerCase()) throw new ResearchCorpusError("invalid_snapshot");
      totalBytes += bytes.byteLength;
      if (totalBytes > RESEARCH_LIMITS.maxTotalBytes) throw new ResearchCorpusError("invalid_snapshot");
      const parsed = parseMarkdown(entry.path, decodeUtf8(bytes));
      if (seenRecordIds.has(parsed.recordId)) throw new ResearchCorpusError("invalid_snapshot");
      seenRecordIds.add(parsed.recordId);
      const contentSha256 = entry.sha256.toLowerCase();
      const sourceId = opaqueDocumentId(entry.path, contentSha256);
      snapshotDigest.update(`${entry.path}\t${contentSha256}\n`);
      documents.push({
        sourceId,
        recordId: parsed.recordId,
        path: entry.path,
        sourceIds: parsed.sourceIds,
        title: parsed.title,
        recordType: parsed.recordType,
        text: parsed.body,
        contentSha256,
        bodyStartLine: parsed.bodyStartLine,
        totalChars: Array.from(parsed.body).length,
      });
    }
    if (!documents.length) throw new ResearchCorpusError("invalid_snapshot");
    const snapshotId = snapshotDigest.digest("hex");

    // Re-read the operator manifest after all content. A concurrent/manual refresh cannot
    // publish a mixture of files from two snapshots.
    const currentManifest = await readManifest(root);
    if (currentManifest.sha256 !== manifestRead.sha256) throw new ResearchCorpusError("invalid_snapshot");

    documents.sort((a, b) => comparePath(a.path, b.path));
    return {
      info: { snapshotId },
      provenance: { commit: manifest.commit?.toLowerCase() ?? null, documentCount: documents.length, totalBytes },
      documents,
      byId: new Map(documents.map((document) => [document.sourceId, document])),
    };
  } catch (error) {
    if (error instanceof ResearchCorpusError) throw error;
    throw new ResearchCorpusError("invalid_snapshot");
  }
}

async function readRegularFile(root: string, filePath: string, maximumBytes: number): Promise<Buffer> {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new ResearchCorpusError("invalid_snapshot");
  const segments = relative.split(path.sep);
  let currentPath = root;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]!);
    const stat = await lstat(currentPath);
    if (stat.isSymbolicLink()) throw new ResearchCorpusError("invalid_snapshot");
    const last = index === segments.length - 1;
    if (last ? !stat.isFile() : !stat.isDirectory()) throw new ResearchCorpusError("invalid_snapshot");
    if (last && stat.size > maximumBytes) throw new ResearchCorpusError("invalid_snapshot");
  }
  const canonical = await realpath(filePath);
  const canonicalRelative = path.relative(root, canonical);
  if (canonicalRelative.startsWith(`..${path.sep}`) || canonicalRelative === ".." || path.isAbsolute(canonicalRelative)) throw new ResearchCorpusError("invalid_snapshot");

  const before = await lstat(filePath);
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.size > maximumBytes) throw new ResearchCorpusError("invalid_snapshot");
    const buffer = Buffer.alloc(opened.size);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const chunk = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (!chunk.bytesRead) throw new ResearchCorpusError("invalid_snapshot");
      bytesRead += chunk.bytesRead;
    }
    if (await handle.stat().then((stat) => stat.size !== opened.size)) throw new ResearchCorpusError("invalid_snapshot");
    return buffer;
  } finally {
    await handle.close();
  }
}

function validateManifestPath(filePath: string): void {
  if (filePath.includes("\\") || filePath.includes("\0") || filePath.startsWith("/") || /^[a-z]:/i.test(filePath)) throw new ResearchCorpusError("invalid_snapshot");
  const parts = filePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts.length > RESEARCH_LIMITS.maxPathDepth) throw new ResearchCorpusError("invalid_snapshot");
  if (filePath !== "index.md" && (!allowedRoots.has(parts[0]!) || parts.length < 2)) throw new ResearchCorpusError("invalid_snapshot");
  if (!filePath.endsWith(".md") || parts.some((part) => part.toLowerCase() === ".git" || /^(?:agents|claude)\.md$/i.test(part))) throw new ResearchCorpusError("invalid_snapshot");
}

function parseMarkdown(filePath: string, markdown: string): { recordId: string; sourceIds: string[]; title: string; recordType: string; body: string; bodyStartLine: number } {
  if (Buffer.byteLength(markdown, "utf8") > RESEARCH_LIMITS.maxFileBytes) throw new ResearchCorpusError("invalid_snapshot");
  if (filePath === "index.md") {
    return { recordId: "research-index", sourceIds: [], title: "Research library index", recordType: "index", body: markdown, bodyStartLine: 1 };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new ResearchCorpusError("invalid_snapshot");
  let value: unknown;
  try { value = JSON.parse(match[1]!); } catch { throw new ResearchCorpusError("invalid_snapshot"); }
  const parsed = frontmatterSchema.safeParse(value);
  if (!parsed.success) throw new ResearchCorpusError("invalid_snapshot");
  const body = markdown.slice(match[0].length);
  return {
    recordId: parsed.data.id,
    sourceIds: [...new Set(parsed.data.source_ids ?? [])].sort(),
    title: parsed.data.title,
    recordType: parsed.data.record_type,
    body,
    bodyStartLine: 1 + (match[0].match(/\n/g)?.length ?? 0),
  };
}

function lineRange(document: SnapshotDocument, offset: number, length: number): { startLine: number; endLine: number } {
  const points = Array.from(document.text);
  const startLine = document.bodyStartLine + countNewlines(points.slice(0, offset).join(""));
  const endLine = length === 0 ? startLine : startLine + countNewlines(points.slice(offset, offset + length).join(""));
  return { startLine, endLine };
}

function opaqueDocumentId(filePath: string, contentSha256: string): string {
  return createHash("sha256").update(`${RESEARCH_REPOSITORY}\n${filePath}\n${contentSha256}`).digest("hex");
}

function makeReadResult(snapshotId: string, document: SnapshotDocument, points: readonly string[], offset: number, end: number): ResearchReadResult {
  const excerpt = points.slice(offset, end).join("");
  const truncated = offset > 0 || end < document.totalChars;
  const lines = lineRange(document, offset, end - offset);
  return {
    snapshotId,
    sourceId: document.sourceId,
    title: document.title,
    path: document.path,
    startLine: lines.startLine,
    endLine: lines.endLine,
    excerpt,
    offset,
    nextOffset: end < document.totalChars ? end : null,
    totalChars: document.totalChars,
    truncated,
  };
}

function boundSearchOutput(snapshotId: string, hits: ResearchSearchHit[], moreMatches: boolean, documents: readonly SnapshotDocument[]): ResearchSearchResult {
  let output: ResearchSearchResult = { snapshotId, hits, truncated: moreMatches || hits.some((hit) => hit.truncated) };
  if (jsonBytes(output) <= MAX_TOOL_RESULT_BYTES) return output;

  const working = hits.map((hit) => ({ ...hit }));
  let changed = true;
  while (jsonBytes({ snapshotId, hits: working, truncated: true }) > MAX_TOOL_RESULT_BYTES && changed) {
    changed = false;
    for (let index = working.length - 1; index >= 0; index -= 1) {
      const hit = working[index]!;
      const points = Array.from(hit.excerpt);
      if (!points.length) continue;
      const reducedLength = Math.floor(points.length / 2);
      const excerpt = points.slice(0, reducedLength).join("");
      const excerptChars = Array.from(excerpt).length;
      const document = documents.find((item) => item.sourceId === hit.sourceId);
      if (!document) continue;
      const lines = lineRange(document, hit.offset, excerptChars);
      working[index] = {
        ...hit,
        startLine: lines.startLine,
        endLine: lines.endLine,
        excerpt,
        nextOffset: hit.offset + excerptChars < hit.totalChars ? hit.offset + excerptChars : null,
        truncated: true,
      };
      changed = true;
      if (jsonBytes({ snapshotId, hits: working, truncated: true }) <= MAX_TOOL_RESULT_BYTES) break;
    }
    if (!changed || working.every((hit) => !hit.excerpt.length)) break;
  }

  while (working.length && jsonBytes({ snapshotId, hits: working, truncated: true }) > MAX_TOOL_RESULT_BYTES) working.pop();
  output = { snapshotId, hits: working, truncated: true };
  return output;
}

function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparePath(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function decodeUtf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ResearchCorpusError("invalid_snapshot"); }
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function tokenize(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let start = 0;
  while (count < 20) {
    const index = text.indexOf(term, start);
    if (index < 0) break;
    count += 1;
    start = index + term.length;
  }
  return count;
}

function makeExcerpt(document: SnapshotDocument, queryTerms: readonly string[]): { text: string; offset: number; truncated: boolean } {
  const source = Array.from(document.text);
  if (source.length <= RESEARCH_LIMITS.maxExcerptChars) return { text: source.join(""), offset: 0, truncated: false };
  const normalizedText = normalize(document.text);
  let matchOffset = -1;
  for (const term of queryTerms) {
    const index = normalizedText.indexOf(term);
    if (index >= 0 && (matchOffset < 0 || index < matchOffset)) matchOffset = index;
  }
  const approximateOffset = matchOffset < 0 ? 0 : Array.from(document.text.slice(0, matchOffset)).length;
  const offset = Math.max(0, Math.min(source.length - RESEARCH_LIMITS.maxExcerptChars, approximateOffset - 120));
  const text = source.slice(offset, offset + RESEARCH_LIMITS.maxExcerptChars).join("");
  return { text, offset, truncated: offset > 0 || offset + RESEARCH_LIMITS.maxExcerptChars < source.length };
}

function countNewlines(value: string): number { return value.match(/\n/g)?.length ?? 0; }
