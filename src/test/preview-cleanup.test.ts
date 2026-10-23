import { describe, expect, it } from "vitest";
import { candidateBranches, cleanup, PROJECT_ID, REPOSITORY, TEAM_ID } from "../../scripts/cleanup-preview-deployments.mjs";

const headSha = "a".repeat(40);
const repo = { full_name: REPOSITORY };
const pr = (overrides = {}) => ({ number: 68, state: "closed", merged_at: "2026-10-15T01:00:00Z", head: { ref: "codex/example", sha: headSha, repo }, base: { ref: "main", repo }, ...overrides });
const deployment = (overrides = {}) => ({ uid: "dpl_example", projectId: PROJECT_ID, created: Date.parse("2026-10-14T01:00:00Z"), target: null, meta: { githubOrg: "chardy-b", githubRepo: "wildheartsai", githubCommitRef: "codex/example", githubCommitSha: headSha }, ...overrides });

describe("merged preview cleanup", () => {
  it("selects merged same-repository previews and preserves production, open and unmerged work", () => {
    expect(candidateBranches([pr()], [deployment()], "main")).toHaveLength(1);
    for (const pulls of [[pr({ state: "open" })], [pr({ merged_at: null })], [pr({ head: { ref: "codex/example", sha: headSha, repo: { full_name: "fork/wildheartsai" } } })], [pr(), pr({ number: 69, state: "open", merged_at: null })], [pr(), pr({ number: 69, merged_at: null })]]) {
      expect(candidateBranches(pulls, [deployment()], "main")).toEqual([]);
    }
    for (const changed of [deployment({ target: "production" }), deployment({ projectId: "another-project" }), deployment({ created: Date.parse("2026-10-16T01:00:00Z") })]) {
      expect(candidateBranches([pr()], [changed], "main")).toEqual([]);
    }
    expect(candidateBranches([pr({ head: { ref: "main", sha: headSha, repo } })], [deployment({ meta: { ...deployment().meta, githubCommitRef: "main" } })], "main")).toEqual([]);
  });

  function fixture(options: { branch?: unknown; alias?: string; compare?: string; currentHead?: string; newOpenPR?: boolean; failList?: boolean; repeatCursor?: boolean; prBoundRebase?: boolean } = {}) {
    const deleted: string[] = [];
    const logs: string[] = [];
    let pullsRead = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "api.vercel.com") expect(url.searchParams.get("teamId")).toBe(TEAM_ID);
      const path = url.pathname;
      let body: unknown;
      if (path === `/repos/${REPOSITORY}`) body = { default_branch: "main" };
      else if (path.endsWith("/pulls")) {
        pullsRead++;
        body = url.searchParams.get("state") === "open" ? options.newOpenPR ? [pr({ state: "open" })] : [] : [pr()];
      } else if (path.includes("/branches/")) return options.branch ? Response.json(options.branch) : new Response(null, { status: 404 });
      else if (path.includes("/compare/")) body = { status: options.compare ?? "ahead" };
      else if (path.endsWith("/pulls/68")) body = pr({ head: { ...pr().head, sha: options.currentHead ?? headSha } });
      else if (path === "/v6/deployments") {
        if (options.failList) return new Response(null, { status: 500 });
        expect(url.searchParams.get("projectId")).toBe(PROJECT_ID);
        body = { deployments: [deployment(options.compare ? { meta: { ...deployment().meta, githubCommitSha: "b".repeat(40), ...(options.prBoundRebase ? { githubPrId: "68" } : {}) } } : {})], pagination: options.repeatCursor ? { next: 123 } : {} };
      } else if (path.endsWith("/domains")) body = { domains: [{ name: "www.wildheartsai.com" }] };
      else if (path === "/v13/deployments/dpl_example") {
        if (init.method === "DELETE") { deleted.push(path); return new Response(null, { status: 204 }); }
        body = { ...deployment(options.compare ? { meta: { ...deployment().meta, githubCommitSha: "b".repeat(40), ...(options.prBoundRebase ? { githubPrId: "68" } : {}) } } : {}), alias: options.alias ? [options.alias] : [] };
      } else throw new Error(`Unexpected test request ${path}`);
      return Response.json(body);
    };
    return { deleted, logs, get pullsRead() { return pullsRead; }, run: (apply = true) => cleanup({ githubToken: "synthetic-github", vercelToken: "synthetic-vercel", apply, fetcher, report: (line: string) => logs.push(line) }) };
  }

  it("defaults to dry run and deletes only verified preview IDs when applied", async () => {
    const dry = fixture(); await dry.run(false); expect(dry.deleted).toEqual([]);
    expect(dry.logs.join(" ")).toContain("Would remove 1 previews");
    const applied = fixture(); await applied.run(); expect(applied.deleted).toEqual(["/v13/deployments/dpl_example"]);
    expect(applied.pullsRead).toBe(2);
  });

  it("preserves protected, reused, newly reopened, unmerged and production-aliased previews", async () => {
    for (const options of [{ branch: { protected: true, commit: { sha: headSha } } }, { branch: { protected: false, commit: { sha: "c".repeat(40) } } }, { alias: "www.wildheartsai.com" }, { compare: "diverged" }, { currentHead: "c".repeat(40) }, { newOpenPR: true }]) {
      const f = fixture(options); await f.run(); expect(f.deleted).toEqual([]);
    }
  });

  it("cleans pre-rebase previews only when Vercel binds them to the merged PR", async () => {
    const f = fixture({ compare: "diverged", prBoundRebase: true });
    await f.run(); expect(f.deleted).toEqual(["/v13/deployments/dpl_example"]);
  });

  it("fails closed on incomplete API reads without deleting anything", async () => {
    for (const options of [{ failList: true }, { repeatCursor: true }]) {
      const f = fixture(options); await expect(f.run()).rejects.toThrow(); expect(f.deleted).toEqual([]);
    }
    await expect(cleanup({ githubToken: "", vercelToken: "", apply: true })).rejects.toThrow("Configure");
  });
});
