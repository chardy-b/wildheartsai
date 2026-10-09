import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchCorpus, RESEARCH_MANIFEST_FILENAME } from "../src/research-corpus.js";
import { publishResearchSnapshot } from "../src/research-publisher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; source: string; published: string }> {
  const root = await mkdtemp(path.join(process.cwd(), ".research-publisher-test-"));
  roots.push(root);
  const source = path.join(root, "raw-checkout");
  const published = path.join(root, "published");
  await mkdir(path.join(source, "studies"), { recursive: true });
  await mkdir(published);
  return { root, source, published };
}

function page(id: string, title: string, body: string): string {
  return `---\n${JSON.stringify({ id, record_type: "study", title })}\n---\n${body}\n`;
}

describe("offline research snapshot publisher", () => {
  it("publishes only curated Markdown after engine validation and swaps current with bounded history", async () => {
    const { source, published } = await fixture();
    await writeFile(path.join(source, "studies", "heart.md"), page("heart", "Heart study", "First content."));
    await mkdir(path.join(source, "raw"));
    await writeFile(path.join(source, "raw", "private.md"), "must never be copied", "utf8");
    await writeFile(path.join(source, "studies", "image.pdf"), "binary-placeholder", "utf8");

    const first = await publishResearchSnapshot(source, published);
    expect(first.files).toBe(1);
    const current = path.join(published, "current");
    const firstSnapshot = await new ResearchCorpus({ root: current }).captureSnapshot();
    expect(firstSnapshot.snapshotId).toBe(first.snapshotId);
    const manifest = JSON.parse(await readFile(path.join(current, RESEARCH_MANIFEST_FILENAME), "utf8")) as { files: Array<{ path: string }> };
    expect(manifest.files.map((item) => item.path)).toEqual(["studies/heart.md"]);
    expect(await readdir(published)).toContain("current");

    await writeFile(path.join(source, "studies", "heart.md"), page("heart", "Heart study", "Updated content."));
    const second = await publishResearchSnapshot(source, published);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(await new ResearchCorpus({ root: current }).captureSnapshot()).toEqual({ snapshotId: second.snapshotId });
    const previous = (await readdir(published)).filter((name) => name.startsWith(".health-research-previous-"));
    expect(previous).toHaveLength(1);

    await mkdir(path.join(published, ".health-research-previous-operator-data"));
    await writeFile(path.join(source, "studies", "heart.md"), page("heart", "Heart study", "Third content."));
    await publishResearchSnapshot(source, published);
    await writeFile(path.join(source, "studies", "heart.md"), page("heart", "Heart study", "Fourth content."));
    await publishResearchSnapshot(source, published);
    const retained = (await readdir(published)).filter((name) => /^\.health-research-previous-\d{17}-[0-9a-f-]+$/.test(name));
    expect(retained).toHaveLength(2);
    expect(await readdir(published)).toContain(".health-research-previous-operator-data");
  });

  it("keeps current intact when frontmatter validation or duplicate-id checks fail", async () => {
    const { source, published } = await fixture();
    await writeFile(path.join(source, "studies", "one.md"), page("one", "One", "Good page."));
    const first = await publishResearchSnapshot(source, published);
    const current = path.join(published, "current");

    await writeFile(path.join(source, "studies", "one.md"), "---\nnot-json\n---\nInvalid.", "utf8");
    await expect(publishResearchSnapshot(source, published)).rejects.toThrow();
    expect(await new ResearchCorpus({ root: current }).captureSnapshot()).toEqual({ snapshotId: first.snapshotId });

    await writeFile(path.join(source, "studies", "one.md"), page("duplicate", "One", "One."));
    await writeFile(path.join(source, "studies", "two.md"), page("duplicate", "Two", "Two."));
    await expect(publishResearchSnapshot(source, published)).rejects.toThrow();
    expect(await new ResearchCorpus({ root: current }).captureSnapshot()).toEqual({ snapshotId: first.snapshotId });
  });

  it("rejects overlapping roots and preserves a current directory with an unrecognized marker", async () => {
    const { root, source, published } = await fixture();
    await writeFile(path.join(source, "studies", "one.md"), page("one", "One", "Good page."));
    await expect(publishResearchSnapshot(source, root)).rejects.toThrow("source_and_published_parent_must_be_separate");

    const current = path.join(published, "current");
    await mkdir(current);
    const markerPath = path.join(current, ".wild-hearts-health-research-snapshot");
    await writeFile(markerPath, "operator-owned data\n", "utf8");
    await expect(publishResearchSnapshot(source, published)).rejects.toThrow("current_research_directory_not_managed");
    expect(await readFile(markerPath, "utf8")).toBe("operator-owned data\n");
  });
});
