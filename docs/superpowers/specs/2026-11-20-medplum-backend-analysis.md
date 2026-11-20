# Medplum as the records backend and search: analysis

Date: November 20, 2026. Status: analysis for an owner decision; nothing built.

Question: use open-source Medplum for the records backend and FHIR search? Is it easy to adopt, where would it run (VPS or Cloudflare), where would the data live, and should we instead keep SQLite?

## Short answer

- **Not a drop-in.** Medplum is a Node.js server that needs **PostgreSQL** (13+, 16 in the current install guide) and **Redis** (6+). It has no SQLite option, and it can't run inside a Worker. Adopting it replaces our records store, sync writes and record search, not just a library call.
- **It can't live in Cloudflare's own storage.** Medplum's resources and search indexes are in Postgres. In Cloudflare objects, at most the binary attachments could sit in R2, and only if Medplum's `s3:` storage accepts a custom endpoint, which we haven't confirmed.
- **Biggest trade-off: encryption.** Today every record is sealed with a per-person key before it reaches the database, and deleting a person destroys their key. Medplum stores resources and their search indexes as plaintext in Postgres; that is what makes its FHIR search work. Adopting it means relying on disk encryption and access control instead of per-person sealing.
- **Recommendation:** finish the Cloudflare cutover on D1 first, as planned. If we then want Medplum, run it on its **own small VM, not the GPU VPS**, with managed Postgres (Neon, which we already use) and local Redis, reached from Workers through a Cloudflare Tunnel. Don't run SQLite on the VPS: D1 already is managed SQLite.

## What Medplum is, as a runtime

| Piece | Requirement | Runs on Cloudflare? |
| --- | --- | --- |
| `medplum-server` (Express, Node 22) | Long-running process | Not in Workers. Possible in Cloudflare Containers (GA since April 2026) |
| PostgreSQL | 13+ (16 in the current guide); resources as JSON plus lookup tables per search parameter | No. D1 and Durable Object storage are SQLite |
| Redis | 6+; cache, rate limits, subscriptions and background jobs | No. An external Redis would be needed |
| Binary storage | `binaryStorage`: `file:`, `s3:`, `gs:` or `azure:` | R2 is S3-compatible, but custom-endpoint support in Medplum's `s3:` driver is unconfirmed |
| Auth | Its own OAuth2/OIDC server, Projects, AccessPolicy, patient compartments | n/a (it's an API we'd call) |
| Admin app | Static React app | Pages or Workers static assets |

Search works through Postgres: each resource type has a table with columns for common search parameters, plus lookup tables (tokens, names, addresses and so on) joined per query and written in the same transaction as the resource. That's why there is no SQLite or D1 port.

## Where it could run

**A. Its own VM, with managed Postgres (recommended if we adopt Medplum).** `medplum-server` and Redis in Docker on a small dedicated VM, with Postgres on Neon (point-in-time backups, encryption at rest, already our provider). Workers reach it through a Cloudflare Tunnel, so it has no public port; only the API and chat Workers hold its client credentials. Binaries on R2 if the S3 endpoint can be pointed at it, else on Neon or the VM's disk with backups.

**B. Medplum on the GPU VPS, with Postgres and Redis there too.** Cheapest, but it reverses the chat security boundary we just wrote down: today the VPS holds no database credentials and no record keys, so a compromised inference or research process can't reach anyone's records. Hosting the system of record there, in plaintext, next to the model and research processes, puts every record behind the VPS's weakest service. It also makes the VPS's uptime the records' uptime, and puts Postgres backups, upgrades (one minor version at a time) and monitoring on us. Not recommended.

**C. Medplum in Cloudflare Containers, with Neon and a hosted Redis.** It keeps us off the VPS, but Containers have ephemeral disks and sleep when idle (slow first requests), and Postgres and Redis still live outside Cloudflare. It adds a platform without removing a server. Revisit only if the VM becomes the pain point.

## Where the data would live

| Data | Today (Cloudflare plan) | With Medplum |
| --- | --- | --- |
| Accounts, sessions, Epic connections and tokens, profiles | D1 | D1 (unchanged; Medplum doesn't replace Better Auth) |
| Records (FHIR resources), versions, notes | D1, sealed per person | Medplum's Postgres, plaintext JSON, versioned by Medplum (`_history`) |
| Search indexes | None in the database; filters and chat tools work on decrypted rows | Medplum's Postgres lookup tables, plaintext |
| Documents (uploaded files) | R2, sealed per person | Unchanged (R2), or as Medplum `Binary` in R2 or on disk |
| Chat conversations | One Durable Object per conversation | Unchanged; the chat tools query Medplum instead of the records RPC |
| Demo chart | D1, one central chart | A demo Project or patient in Medplum, read-only |

## What would change in our code

- **Sync** (`api/src/jobs/sync/`): instead of diffing and sealing rows into D1, write each fetched resource to Medplum as a conditional update keyed by its source identifier, tagged with the source organization. Medplum's versioning replaces our supersede chain; removals become deletes or status changes there.
- **Isolation**: today `forUser` scopes every query, and per-person sealing backs it up. With Medplum, each person becomes a Patient compartment. Wild Hearts calls Medplum as a backend client, and each request should go **on behalf of a per-person membership whose AccessPolicy allows only that compartment**, so Medplum enforces the boundary too, not just our code. The table-driven isolation tests would move to Medplum's API.
- **Deletion**: deleting a person changes from destroying their key (crypto-shredding) to `$expunge`, and backups keep the plaintext until they expire.
- **Timeline, record pages, export, the chat tools**: FHIR searches against Medplum instead of D1 reads. This is the real gain: proper date, token, quantity, chained and `_include` searches instead of filtering decrypted rows in code.
- **Extraction to FHIR** (`plans/2026-10-15-pdf-to-fhir-and-medplum.md`) already maps to Medplum's API and would write there directly.

## Recommendation, in order

1. Finish the Cloudflare cutover on D1 as planned. Medplum is a separate change, and swapping the records store mid-migration doubles the risk.
2. Decide on encryption first. If per-person sealing stays a requirement, Medplum's plaintext indexes rule it out as the system of record, and the plan of October 15 stands: Medplum as an optional destination, not a second authoritative store.
3. If Medplum's search is worth it, pilot option A with the recorded Epic sandbox fixtures: Medplum on its own VM, Neon Postgres, Tunnel-only access, one Project with per-person compartments and AccessPolicies. Check the cross-tenant cases from the chat spec against it before moving any real records.
4. Keep the GPU VPS for inference, research and extraction only.

## To verify before deciding

- Whether Medplum's `s3:` binary storage takes a custom endpoint (R2), or needs a patch.
- Medplum's current Postgres and Redis versions, and its supported upgrade path.
- Per-request "on behalf of" access, with compartment-only AccessPolicies, for a backend client in a self-hosted Project.
- Cost and latency of Worker → Tunnel → VM for the timeline's queries, measured with the sandbox fixtures.

Sources: [Medplum install from scratch](https://www.medplum.com/docs/self-hosting/install-from-scratch), [server config](https://www.medplum.com/docs/self-hosting/server-config), [binary data](https://www.medplum.com/docs/fhir-datastore/binary-data), [search architecture](https://medplum.com/docs/contributing/search-architecture), [self-hosting best practices](https://www.medplum.com/docs/self-hosting/best-practices), [projects](https://medplum.com/docs/access/projects), [access policies](https://www.medplum.com/docs/access/access-policies), [multi-tenant access](https://www.medplum.com/docs/access/multi-tenant-access-policy), [Cloudflare Containers GA](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/), [Containers FAQ](https://developers.cloudflare.com/containers/faq/).
