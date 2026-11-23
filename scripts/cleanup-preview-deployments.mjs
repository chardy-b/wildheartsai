import { pathToFileURL } from "node:url";

export const REPOSITORY = "chardy-b/wildheartsai";
export const PROJECT_ID = "prj_PWWNGZAwPoVLhqEjksN7MgXetn6e";
export const TEAM_ID = "team_ZpzZUPGbpNYRUTQPq0FulKxV";
const preservedRefs = new Set(["main", "master", "production", "staging", "develop", "development"]);

export function candidateBranches(pulls, deployments, defaultBranch) {
  const latest = new Map();
  for (const pr of [...pulls].sort((a, b) => b.number - a.number)) {
    if (pr.head?.repo?.full_name !== REPOSITORY) continue;
    if (!latest.has(pr.head.ref)) latest.set(pr.head.ref, pr);
  }
  const candidates = [];
  for (const [ref, pr] of latest) {
    if (preservedRefs.has(ref) || ref === defaultBranch || pr.state !== "closed" || !pr.merged_at || pr.base?.ref !== defaultBranch || pr.base?.repo?.full_name !== REPOSITORY) continue;
    // An older PR for the same ref can still be open, even if the latest one merged.
    if (pulls.some(item => item.state === "open" && item.head?.repo?.full_name === REPOSITORY && item.head.ref === ref)) continue;
    const previews = deployments.filter(item => item.meta?.githubCommitRef === ref);
    if (!previews.length || previews.some(item => !isOwnedPreview(item) || !Number.isFinite(item.created) || item.created > Date.parse(pr.merged_at))) continue;
    candidates.push({ ref, number: pr.number, headSha: pr.head.sha, deployments: previews });
  }
  return candidates;
}

export function isOwnedPreview(deployment) {
  return deployment.projectId === PROJECT_ID && deployment.target !== "production" &&
    [null, undefined, "preview"].includes(deployment.target) &&
    deployment.meta?.githubOrg === "chardy-b" && deployment.meta?.githubRepo === "wildheartsai" &&
    typeof deployment.meta?.githubCommitSha === "string" && /^[a-f0-9]{40}$/.test(deployment.meta.githubCommitSha);
}

export async function cleanup({ githubToken, vercelToken, apply = false, fetcher = fetch, report = console.log }) {
  if (!githubToken || !vercelToken) throw new Error("Configure GITHUB_TOKEN and the repository VERCEL_TOKEN secret before running preview cleanup.");
  async function request(base, path, token, method = "GET", allowMissing = false) {
    const url = new URL(path, base);
    if (base.includes("vercel.com")) url.searchParams.set("teamId", TEAM_ID);
    const response = await fetcher(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "wildhearts-preview-cleanup" }, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Cleanup API ${method} ${url.pathname} failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  }
  const gh = (path, allowMissing = false) => request("https://api.github.com", path, githubToken, "GET", allowMissing);
  const vc = (path, method = "GET") => request("https://api.vercel.com", path, vercelToken, method);
  const repo = await gh(`/repos/${REPOSITORY}`);
  const pulls = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Pull request pagination exceeded the safety bound; nothing was deleted.");
    const batch = await gh(`/repos/${REPOSITORY}/pulls?state=all&per_page=100&page=${page}`);
    pulls.push(...batch);
    if (batch.length < 100) break;
  }
  const deployments = [], cursors = new Set();
  let until;
  for (let page = 0; ; page++) {
    if (page >= 100) throw new Error("Deployment pagination exceeded the safety bound; nothing was deleted.");
    const batch = await vc(`/v6/deployments?projectId=${PROJECT_ID}&limit=100${until ? `&until=${until}` : ""}`);
    deployments.push(...batch.deployments);
    const next = batch.pagination?.next;
    if (!next) break;
    if (cursors.has(next)) throw new Error("Deployment pagination did not advance; nothing was deleted.");
    cursors.add(next); until = next;
  }
  const domains = await vc(`/v9/projects/${PROJECT_ID}/domains?limit=100`);
  // Preserve every production domain; fail closed if the response needs another page.
  if (domains.pagination?.next) throw new Error("Domain pagination requires review; nothing was deleted.");
  const productionDomains = new Set(domains.domains.filter(item => !item.gitBranch && !item.customEnvironmentId).map(item => item.name));
  const candidates = candidateBranches(pulls, deployments, repo.default_branch);
  let deleted = 0;
  for (const candidate of candidates) {
    const branch = await gh(`/repos/${REPOSITORY}/branches/${encodeURIComponent(candidate.ref)}`, true);
    if (branch && (branch.protected || branch.commit?.sha !== candidate.headSha)) {
      report(`Preserved ${candidate.ref}: protected or changed since merge.`); continue;
    }
    // Vercel's PR binding includes pre-rebase deployments. Without that binding,
    // require commit ancestry rather than guessing from a reused branch name.
    let safe = true;
    const unbound = candidate.deployments.filter(item => item.meta.githubPrId !== String(candidate.number));
    for (const sha of new Set(unbound.map(item => item.meta.githubCommitSha))) {
      if (sha === candidate.headSha) continue;
      const comparison = await gh(`/repos/${REPOSITORY}/compare/${sha}...${candidate.headSha}`);
      if (!["ahead", "identical"].includes(comparison.status)) { safe = false; break; }
    }
    if (!safe) { report(`Preserved ${candidate.ref}: deployment contains unmerged work.`); continue; }
    for (const deployment of candidate.deployments) {
      const detail = await vc(`/v13/deployments/${deployment.uid}`);
      if (!isOwnedPreview(detail) || detail.meta.githubCommitRef !== candidate.ref || detail.meta.githubCommitSha !== deployment.meta.githubCommitSha || (detail.alias ?? []).some(alias => productionDomains.has(alias))) {
        safe = false; break;
      }
    }
    if (!safe) { report(`Preserved ${candidate.ref}: deployment ownership or production aliases changed.`); continue; }
    report(`${apply ? "Removing" : "Would remove"} ${candidate.deployments.length} previews for merged PR #${candidate.number} (${candidate.ref}).`);
    if (!apply) continue;
    // Recheck PR/branch state immediately before mutation, including branch reuse.
    const currentPR = await gh(`/repos/${REPOSITORY}/pulls/${candidate.number}`);
    const currentBranch = await gh(`/repos/${REPOSITORY}/branches/${encodeURIComponent(candidate.ref)}`, true);
    const openPulls = await gh(`/repos/${REPOSITORY}/pulls?state=open&head=${encodeURIComponent(`chardy-b:${candidate.ref}`)}&per_page=100`);
    if (!currentPR.merged_at || currentPR.base?.ref !== repo.default_branch || currentPR.head?.repo?.full_name !== REPOSITORY || currentPR.head.sha !== candidate.headSha || openPulls.length || (currentBranch && (currentBranch.protected || currentBranch.commit?.sha !== candidate.headSha))) {
      report(`Preserved ${candidate.ref}: state changed during cleanup.`); continue;
    }
    for (const deployment of candidate.deployments) {
      const detail = await vc(`/v13/deployments/${deployment.uid}`);
      if (!isOwnedPreview(detail) || detail.meta.githubCommitRef !== candidate.ref || detail.meta.githubCommitSha !== deployment.meta.githubCommitSha || (detail.alias ?? []).some(alias => productionDomains.has(alias))) throw new Error("Deployment changed before deletion; cleanup stopped.");
      await vc(`/v13/deployments/${deployment.uid}`, "DELETE");
      deleted++;
    }
  }
  report(`Preview cleanup ${apply ? "completed" : "dry run completed"}: ${deleted} deployments deleted. Neon cleans linked branches asynchronously after their last deployment is removed.`);
  return { deleted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanup({ githubToken: process.env.GITHUB_TOKEN, vercelToken: process.env.VERCEL_TOKEN, apply: process.env.PREVIEW_CLEANUP_APPLY === "true" })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
