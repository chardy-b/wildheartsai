---
name: pr-delivery
description: Check Wild Hearts AI PR checks, complete an authorized merge or deployment, and clean up the merged PR branch. Use for PR delivery and deployment requests in this repository.
---

# PR delivery

Repository: `chardy-b/wildheartsai`. Production deploys from `main` through Vercel's GitHub integration. This skill does not authorize merging or deploying by itself; use the user's existing authorization.

## Before merging

- Run the four delivery checks listed in `AGENTS.md`. On Windows, if Vitest's process workers stall or cannot access their temporary files, use `npm test -- --pool=threads`; report failures accurately.
- Read the PR's current head SHA. Inspect both GitHub Actions/check runs and commit statuses (including Vercel) for that SHA. The combined commit-status endpoint alone does not include all GitHub Actions checks. Use the GitHub connector, or `gh pr checks <number>` when available, and inspect failed job logs.
- Wait for pending checks with bounded polls, spaced about 30 seconds apart, and keep the user updated. Re-read the head SHA before merging; if it changed, inspect checks for the new SHA. Merge with the expected head SHA to avoid merging an unchecked update.
- Do not treat missing, skipped required, cancelled, timed-out, or inaccessible checks as passed. Fix code failures and rerun the affected checks. If the same infrastructure failure repeats after one retry, report the blocker instead of looping.
- A Vercel preview provisioning failure is a failed check, even when local checks pass. Explain the failure and obtain an explicit exception before merging with that failure. Respect required checks and branch protections; do not disable them to force a merge.

## After an authorized merge

- Verify that the PR merged into `main` and record the resulting commit SHA. Confirm the production Vercel deployment is Ready, corresponds to that SHA, and has the live domain alias. Check `/api/health` and the relevant public page without exposing credentials or health records. Do not report the change as live based only on a successful merge.
- GitHub's repository setting `delete_branch_on_merge` should remain enabled so merged PR head branches are deleted automatically. Verify the PR's remote branch is gone; if it remains, check whether branch protection or another open PR requires it before attempting cleanup.
- Automatic cleanup applies to the merged PR's head branch, not every branch that looks old. Never delete `main`, the default branch, protected branches, a branch used by an open PR, or a branch whose current tip differs from the merged PR's recorded head SHA. Preserve fork branches owned by others.
- Fetch with pruning to remove stale remote-tracking references. Delete a local merged branch only when it has no unmerged work and is not checked out in any worktree. Use `git branch -d`, not forced deletion; squash merges may need the local branch kept. Do not remove an active worktree to clean up its branch.
- Report the CI result, deployment result, and any branch cleanup that remains blocked separately.
