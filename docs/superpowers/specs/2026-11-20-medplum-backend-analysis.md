# Medplum as the records backend and search: analysis

Date: November 20, 2026. Status: direction decided (below, "Decisions and answers"); nothing built.

Question: use open-source Medplum for the records backend and FHIR search? Is it easy to adopt, where would it run (VPS or Cloudflare), where would the data live, and should we instead keep SQLite?

## Short answer

- **Not a drop-in.** Medplum is a Node.js server that needs **PostgreSQL** (13+, 16 in the current install guide) and **Redis** (6+). It has no SQLite option, and it can't run inside a Worker. Adopting it replaces our records store, sync writes and record search, not just a library call.
- **It can't live in Cloudflare's own storage.** Medplum's resources and search indexes are in Postgres. In Cloudflare objects, at most the binary attachments could sit in R2, and only if Medplum's `s3:` storage accepts a custom endpoint, which we haven't confirmed.
- **Biggest trade-off: encryption.** Today every record is sealed with a per-person key before it reaches the database, and deleting a person destroys their key. Medplum stores resources and their search indexes as plaintext in Postgres; that is what makes its FHIR search work. Adopting it means relying on disk encryption and access control instead of per-person sealing.
- **Recommendation:** finish the Cloudflare cutover on D1 first, as planned. If we then want Medplum, run it on its **own small VM, not the GPU VPS**, with managed Postgres (Neon, which we already use) and local Redis, reached from Workers through a Cloudflare Tunnel. Don't run SQLite on the VPS: D1 already is managed SQLite.

## Decisions and answers (November 20, later)

Owner decisions: long term, **Medplum on our own VPS is the main backend**, on Postgres. Per-person encryption **isn't a requirement** for now. **Move to Cloudflare first.** **Medplum's admin interface and tools are for Wild Hearts admins** (its admin app, Bots, Subscriptions, `$export`): served only to admin accounts. A sketch: the admin app on its own hostname behind Cloudflare Access (or the Tunnel), signing in to a Medplum project membership with an admin AccessPolicy; patients never get a Medplum login, and reach their data only through our API.

### Is moving to Cloudflare first still worth it?

Yes. Most of what's been built isn't about where records are stored:
- **Carries over:** the web app on Workers, Better Auth and sessions, Epic connect and tokens, sync orchestration (Workflows), Documents in R2, extraction coordination, chat (Pi durable, one Durable Object per conversation), the demo, rate limits.
- **Temporary:** the D1 records tables and their read paths (timeline, record pages, notes, export, chat's records RPC), roughly a fifth of the API. When Medplum arrives they become Medplum calls behind the same routes, so pages don't change.
- **No second migration of records:** they come from Epic and Metriport and can be re-synced straight into Medplum. Only records Wild Hearts made itself (from documents) need copying.
- **What's left on Cloudflare:** the chat port and the cutover, both needed whatever the records store becomes.

Two consequences of records on the VPS, to plan for:
- Every record read becomes Worker → Cloudflare Tunnel → VPS, so the VPS's uptime is the records' uptime (backups, monitoring, upgrades one Medplum minor version at a time).
- It changes the chat boundary: today the VPS holds no record data. Keep Medplum and its Postgres away from the inference and research processes: another host is best; at the least, separate containers, networks and credentials.

### Medplum as the entire backend, or our own source of truth synced to it?

Neither, exactly. **Make Medplum the source of truth for clinical data (the FHIR resources), and keep our API as the backend for everything else. Mirror nothing.**
- **Medplum isn't a good fit for the rest:** Better Auth accounts and sessions, Epic OAuth tokens and connection state, sync scheduling and cursors, chat, rate limits, the demo, Documents' upload flow and quotas. Those stay in our API and D1.
- **Why not our own store plus a Medplum mirror for search:** two copies of every record, every correction and deletion propagated, drift between them, and two places to secure. It's only worth it if our store has to hold something Medplum can't (per-person sealing was that reason), which no longer applies.
- **What owning clinical data in Medplum means for the code:**
  - Sync writes transaction bundles of conditional updates, keyed by an identifier (source URL plus Epic's id), with references between imported resources rewritten inside the bundle.
  - Records are tagged with their source, so deleting a source deletes by tag.
  - Medplum's history replaces our supersede chain.
  - Each person is a Patient compartment. Requests go on behalf of a membership whose AccessPolicy allows only that compartment.

### How much does Medplum give us over building search ourselves?

Our record queries today are per person and small (hundreds to a few thousand records each):
- filter by category, source and date;
- text search over titles and notes;
- a record by id;
- lab trends by code;
- coverage counts.

**Without encryption, our own search is cheap:** plaintext columns (code, display, date, value, unit, status) plus Postgres full-text or trigram search, or SQLite FTS5 in D1, covers all of that in a couple of weeks.

**What Medplum adds beyond search:**
- full FHIR search (token systems, quantities with units, chaining, `_include` and `_revinclude`);
- versioning and history;
- validation against profiles;
- terminology services (`$expand`, `$validate-code`; needs code systems loaded, and LOINC and SNOMED have licence terms);
- Subscriptions and Bots;
- a SMART on FHIR server, so other apps can read a person's data with their consent;
- bulk `$export`, access policies, an admin UI;
- a standard API that extraction already targets.

**Verdict:** for search alone, Medplum isn't worth running a server, Postgres and Redis. It earns its keep when Wild Hearts becomes a FHIR platform:
- apps or care teams reading the data;
- workflows (tasks, care plans, messages);
- terminology-backed normalization, such as mapping labs from several health systems to LOINC so trends join up.

Since that's the stated direction, adopt Medplum as the clinical store when the first of those features starts. Don't build our own search first and throw it away. If that's more than a quarter or two out and search is needed sooner, add the plaintext columns and full-text index to the existing store as a stopgap: small, and replaced by Medplum's search later.

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

## Recommendation, in order (before the decisions above)

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
