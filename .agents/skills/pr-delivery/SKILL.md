---
name: pr-delivery
description: Check Wild Hearts AI PR checks, complete an authorized merge or deployment, and clean up the merged PR branch. Use for PR delivery and deployment requests in this repository.
---

# PR delivery

Repository: `chardy-b/wildheartsai`. `main` currently serves production through Vercel. The Cloudflare migration on `cloudflare` uses the [release runbook](../../../docs/cloudflare-release-runbook.md). The proposed protected `prod` branch is not a live release path until its gates are configured and verified. This skill does not authorize merging or deploying by itself.

## Before merging

- Run the four delivery checks listed in `AGENTS.md`. On Windows, if Vitest's process workers stall or cannot access their temporary files, use `npm test -- --pool=threads`; report failures accurately.
- Read the PR's current head SHA. Inspect both GitHub Actions/check runs and commit statuses (including Vercel) for that SHA. The combined commit-status endpoint alone does not include all GitHub Actions checks. Use the GitHub connector, or `gh pr checks <number>` when available, and inspect failed job logs.
- Wait for pending checks with bounded polls, spaced about 30 seconds apart, and keep the user updated. Re-read the head SHA before merging; if it changed, inspect checks for the new SHA. Merge with the expected head SHA to avoid merging an unchecked update.
- Do not treat missing, skipped required, cancelled, timed-out, or inaccessible checks as passed. Fix code failures and rerun the affected checks. If the same infrastructure failure repeats after one retry, report the blocker instead of looping.
- A Vercel preview provisioning failure is a failed check, even when local checks pass. Explain the failure and obtain an explicit exception before merging with that failure. Respect required checks and branch protections; do not disable them to force a merge.
- On the Cloudflare line, a Vercel preview never substitutes for Cloudflare checks or a staging receipt. Confirm the expected environment and both migration ledgers before attempting Cloudflare deployment. A docs PR can still trigger the current same-repository preview jobs if enabled; check that before opening it.

## After an authorized merge

- Verify the intended base and resulting commit SHA. On `main`, confirm the production Vercel deployment is Ready, corresponds to that SHA, and has the live domain alias. Check `/api/health` and the relevant public page without exposing credentials or health records.
- On `cloudflare` or a future `prod`, follow the runbook and report separately whether Cloudflare deployment was configured, ran, and passed smoke checks on the intended stack. Record all three Worker versions for a verified release. A merge, Vercel preview, or staged Worker upload does not mean it is live on Cloudflare.
- GitHub's repository setting `delete_branch_on_merge` should remain enabled so merged PR head branches are deleted automatically. Verify the PR's remote branch is gone; if it remains, check whether branch protection or another open PR requires it before attempting cleanup.
- Automatic cleanup applies to disposable PR head branches only. Never delete `main`, `cloudflare`, `prod`, the default branch, protected branches, a branch used by an open PR, or a branch whose current tip differs from the merged PR's recorded head SHA. Before enabling promotion PRs from long-lived `cloudflare`, protect it against deletion; do not rely on an automatic cleanup setting to preserve it. Preserve fork branches owned by others.
- Fetch with pruning to remove stale remote-tracking references. Delete a local merged branch only when it has no unmerged work and is not checked out in any worktree. Use `git branch -d`, not forced deletion; squash merges may need the local branch kept. Do not remove an active worktree to clean up its branch.
- Report the CI result, deployment result, and any branch cleanup that remains blocked separately.
