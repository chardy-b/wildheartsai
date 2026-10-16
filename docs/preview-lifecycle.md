# Preview lifecycle and October 15, 2026 retrospective

The Neon project reached its ten-branch limit with one production branch, four preview branches tied to open PRs, and five preview branches for merged PRs. GitHub had already deleted those five merged Git branches. The remaining database previews belonged to PRs #68–#72; open PRs #51, #54, #67 and #73 still needed their previews. PR #63 overlaps #67 and has no separate remaining database preview.

The Vercel-managed Neon integration retains a database branch while any corresponding preview deployment exists. It deletes the database branch asynchronously after the final deployment is deleted. Git branch deletion alone therefore does not release these database slots. The project had 30-day deployment retention and retained ten deployments, which is too slow to prevent a ten-branch ceiling during active development.

Sources: [Neon integration cleanup](https://neon.com/blog/big-dx-improvements-for-neon-users-on-vercel), [Vercel deployment retention](https://vercel.com/docs/deployments/retention-policy).

## Cleanup after merging

`.github/workflows/preview-cleanup.yml` runs after a merged PR closes and sweeps all eligible merged-PR previews, including leftovers from earlier merges. It checks out trusted default-branch code, never the PR head, and uses read-only GitHub permissions. GitHub's automatic deletion of merged source branches remains responsible for Git refs.

The script verifies repository/project ownership, a merged PR into the default branch, no open PR using that ref, no newer closed-unmerged PR, no protected or advanced Git branch, and no deployments created after the merge. Each deployment must be bound to that merged PR in Vercel metadata (including pre-rebase builds), or its commit must be included in the merged head. It also preserves production deployments and any deployment holding a production domain, and rechecks state immediately before deletion. Ambiguous resources are preserved for review. It never deletes local worktrees, source files, production databases, or active-work previews.

Removing the Vercel previews lets the native integration delete their Neon database branches; the job needs no database credentials or Neon API key. Preview-only data and preview URLs for completed work are discarded. Retain a deliberately long-lived environment on a protected branch.

## Activation and recovery

Set a repository Actions secret named `VERCEL_TOKEN`, scoped to the `lichards-projects` team with the access required to list project deployments/domains and delete previews. Configure it directly in GitHub settings; do not paste it into chat or commit it. The project/team IDs are fixed in the script, and the automatically supplied `GITHUB_TOKEN` only reads repository metadata. No credentials are retrieved from Vercel CLI authentication files.

After merging the workflow, run **Clean merged PR previews** manually with `apply=false` to review the plan. Run with `apply=true` to reconcile historical leftovers and verify Neon removes the corresponding branches. Then set repository Actions variable `PREVIEW_CLEANUP_ENABLED=true` to enable automatic deletion on future merges. Until that variable is set, merge events only perform a dry run, so merging the workflow cannot silently apply cleanup before its plan is reviewed. Missing credentials and API errors fail visibly; they never fall back to guessed targets or partial inventories. Failed runs can be rerun once the underlying issue is resolved.

No periodic cron is needed initially: every merge reconciles the backlog, and manual dispatch handles recovery. Add a scheduled reconciliation only if merge-triggered cleanup proves insufficient. Keep Vercel retention as a secondary safety net, rather than shortening retention for production rollbacks.
