import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RESEARCH_LIMITS,
  RESEARCH_MANIFEST_FILENAME,
  RESEARCH_REPOSITORY,
  ResearchCorpus,
  ResearchCorpusError,
} from "../src/research-corpus.js";
import { researchReadOutputSchema } from "../src/protocol.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), ".research-corpus-test-"));
  roots.push(root);
  return root;
}

function markdown(id: string, title: string, body: string): string {
  return `---\n${JSON.stringify({ id, record_type: "study", title })}\n---\n${body}\n`;
}

async function putSnapshot(root: string, files: Record<string, string>, commit?: string): Promise<void> {
  const entries = [];
  for (const [relative, contents] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const destination = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
    const bytes = Buffer.from(contents, "utf8");
    entries.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(path.join(root, RESEARCH_MANIFEST_FILENAME), JSON.stringify({
    version: 1,
    repository: RESEARCH_REPOSITORY,
    ...(commit ? { commit } : {}),
    files: entries,
  }), "utf8");
}

async function expectCorpusError(action: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    expect.fail(`Expected ResearchCorpusError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchCorpusError);
    expect((error as ResearchCorpusError).code).toBe(code);
  }
}

describe("ResearchCorpus", () => {
  it("loads a curated snapshot, ranks title matches, and returns flat bounded citations", async () => {
    const root = await fixture();
    await putSnapshot(root, {
      "studies/heart-study.md": markdown("heart-study", "Heart outcomes", "A randomized study of heart outcomes."),
      "conditions/other.md": markdown("other", "Other condition", "Heart outcomes were mentioned as a comparison."),
    });
    await mkdir(path.join(root, "raw"), { recursive: true });
    await writeFile(path.join(root, "raw", "private.md"), "This must not be indexed.", "utf8");
    const corpus = new ResearchCorpus({ root });
    const snapshot = await corpus.captureSnapshot();
    expect(snapshot.snapshotId).toMatch(/^[a-f0-9]{64}$/);

    const result = corpus.search(snapshot.snapshotId, { query: "heart outcomes", limit: 5 });
    expect(result.hits.length).toBe(2);
    expect(result.hits[0]!.title).toBe("Heart outcomes");
    expect(result.hits[0]!.path).toBe("studies/heart-study.md");
    expect(result.hits[0]!.startLine).toBeGreaterThan(0);
    expect(result.hits[0]!.sourceId).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(result.hits[0]!).sort()).toEqual([
      "endLine", "excerpt", "nextOffset", "offset", "path", "sourceId", "startLine", "title", "totalChars", "truncated",
    ]);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(32 * 1024);
    expect(result.hits[0]!.excerpt).not.toContain("This must not");
  });

  it("uses content-derived snapshot ids and keeps immutable snapshots across manual refresh", async () => {
    const root = await fixture();
    const firstContent = markdown("study", "First title", "first body");
    await putSnapshot(root, { "studies/one.md": firstContent }, "a".repeat(40));
    const corpus = new ResearchCorpus({ root });
    const first = await corpus.captureSnapshot();
    const firstHit = corpus.search(first.snapshotId, { query: "first" }).hits[0]!;

    await putSnapshot(root, { "studies/one.md": firstContent }, "b".repeat(40));
    const sameContent = await corpus.captureSnapshot();
    expect(sameContent.snapshotId).toBe(first.snapshotId);

    await putSnapshot(root, { "studies/one.md": markdown("study", "Second title", "second body") });
    const second = await corpus.captureSnapshot();
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(corpus.read(first.snapshotId, { sourceId: firstHit.sourceId }).excerpt).toContain("first body");
    expect(corpus.search(second.snapshotId, { query: "second" }).hits[0]!.title).toBe("Second title");
  });

  it("paginates long Unicode markdown by code point with stable line metadata", async () => {
    const root = await fixture();
    const body = `Start\n${"🫀research ".repeat(1300)}\nEnd marker`;
    await putSnapshot(root, { "studies/long.md": markdown("long", "Long study", body) });
    const corpus = new ResearchCorpus({ root });
    const snapshot = await corpus.captureSnapshot();
    const hit = corpus.search(snapshot.snapshotId, { query: "research" }).hits[0]!;
    const first = corpus.read(snapshot.snapshotId, { sourceId: hit.sourceId, limit: 12000 });
    expect(first.excerpt.length).toBeLessThanOrEqual(RESEARCH_LIMITS.maxReadChars);
    expect(Array.from(first.excerpt).length).toBeLessThanOrEqual(RESEARCH_LIMITS.maxReadChars);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThan(32 * 1024);
    expect(first.nextOffset).not.toBeNull();
    const second = corpus.read(snapshot.snapshotId, { sourceId: hit.sourceId, offset: first.nextOffset!, limit: 12000 });
    expect(first.excerpt + second.excerpt).toContain("End marker");
    expect(first.totalChars).toBeGreaterThan(12000);
    expect(first.startLine).toBeGreaterThan(0);
    expect(second.offset).toBe(first.nextOffset);
    expect(researchReadOutputSchema.parse(second)).toEqual(second);
  });

  it("rejects traversal paths and malformed tool input without exposing filesystem selection", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(path.join(outside, "secret.md"), "must not be read", "utf8");
    await writeFile(path.join(root, RESEARCH_MANIFEST_FILENAME), JSON.stringify({
      version: 1,
      repository: RESEARCH_REPOSITORY,
      files: [{ path: "../secret.md", bytes: 15, sha256: "0".repeat(64) }],
    }), "utf8");
    const corpus = new ResearchCorpus({ root });
    await expectCorpusError(() => corpus.captureSnapshot(), "invalid_snapshot");

    await putSnapshot(root, { "studies/one.md": markdown("one", "One", "body") });
    const snapshot = await corpus.captureSnapshot();
    await expectCorpusError(() => corpus.search(snapshot.snapshotId, { query: "body", path: "../../secret" }), "invalid_request");
    await expectCorpusError(() => corpus.read(snapshot.snapshotId, { sourceId: "../../secret" }), "invalid_request");
    await expectCorpusError(() => corpus.read(snapshot.snapshotId, { sourceId: corpus.search(snapshot.snapshotId, { query: "body" }).hits[0]!.sourceId, offset: 999 }), "invalid_request");
  });

  it("rejects symlinks and retains the last valid snapshot when a manual update is incomplete", async () => {
    const root = await fixture();
    await putSnapshot(root, { "studies/one.md": markdown("one", "One", "stable body") });
    const corpus = new ResearchCorpus({ root });
    const snapshot = await corpus.captureSnapshot();
    const sourceId = corpus.search(snapshot.snapshotId, { query: "stable" }).hits[0]!.sourceId;

    await putSnapshot(root, { "studies/one.md": markdown("one", "One", "changed body") });
    await writeFile(path.join(root, RESEARCH_MANIFEST_FILENAME), "{", "utf8");
    await expectCorpusError(() => corpus.captureSnapshot(), "invalid_snapshot");
    expect(corpus.read(snapshot.snapshotId, { sourceId }).excerpt).toContain("stable body");

    const linkedRoot = await fixture();
    await mkdir(path.join(linkedRoot, "studies"));
    await putSnapshot(linkedRoot, { "studies/one.md": markdown("one", "One", "body") });
    const target = path.join(linkedRoot, "studies", "target.md");
    const linked = path.join(linkedRoot, "studies", "link.md");
    await writeFile(target, markdown("target", "Target", "body"));
    try {
      await symlink(target, linked, "file");
    } catch {
      return; // Symlink creation can be disabled by Windows host policy.
    }
    const original = JSON.parse(await readFile(path.join(linkedRoot, RESEARCH_MANIFEST_FILENAME), "utf8")) as { files: Array<{ path: string; bytes: number; sha256: string }> };
    const bytes = await readFile(linked);
    original.files.push({ path: "studies/link.md", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await writeFile(path.join(linkedRoot, RESEARCH_MANIFEST_FILENAME), JSON.stringify({ version: 1, repository: RESEARCH_REPOSITORY, files: original.files }), "utf8");
    await expectCorpusError(() => new ResearchCorpus({ root: linkedRoot }).captureSnapshot(), "invalid_snapshot");
  });

  it("caps the retained snapshot cache and rejects evicted snapshot ids", async () => {
    const root = await fixture();
    const corpus = new ResearchCorpus({ root });
    const ids: string[] = [];
    for (let index = 0; index < RESEARCH_LIMITS.maxSnapshots + 1; index += 1) {
      await putSnapshot(root, { "studies/one.md": markdown("one", "One", `version ${index}`) });
      ids.push((await corpus.captureSnapshot()).snapshotId);
    }
    await expectCorpusError(() => corpus.search(ids[0], { query: "version" }), "not_found");
    expect(corpus.search(ids.at(-1), { query: "version" }).hits).toHaveLength(1);
  });
});
