# Epic directory: search health systems and their clinics

**Goal:** let people find their health system by the hospital or clinic they visited, and reach systems that Epic lists only in its newer Brands list, without changing anything that connects today.

## Why

The connect search read only Epic's R4 endpoint list (`open.epic.com/Endpoints/R4`): about 450 health systems, one name each, no clinics and no locations. Epic's Brands bundle (`open.epic.com/Endpoints/Brands`) has about 1,300 brands, each with a FHIR address, and about 96,000 facilities that belong to a brand, with city and state. Checked against the list on 2026-09-30:

- About 500 Brands addresses aren't in the R4 list. Northwell Health and Summit Health (New Jersey) are among them, so neither could be found.
- Clinics could only be found through their parent's name: "Spaulding" (Mass General Brigham), "Pardee" (UNC Health Care) and "Peninsula Ophthalmology" (Sutter Health) found nothing.
- Same-named systems couldn't be told apart: R4's "Summit Health" is the Oregon one.

## Design

- **Import, don't fetch per search.** The bundle is ~95 MB, too big for Next's fetch cache and too slow per request. `refresh-epic-directory` (Inngest, daily at 08:41 UTC, or on `epic/directory.refresh-requested`) downloads both lists, merges them (`buildDirectory` in `src/lib/epic/brands.ts`) and replaces `epic_directory_entry` in one transaction (`replaceDirectory`). An unchanged list only records the check in `epic_directory_import`. A failed download, or fewer than 500 organizations, keeps the stored directory.
- **R4 wins where both lists describe one system**, because existing connections and their Reconnect links use R4 addresses:
  - the same address in different letter case keeps the R4 spelling;
  - a brand with the same name and host as an R4 entry, but a different path (`…/HOME/api/FHIR/R4`), uses the R4 address (81 systems);
  - the same name on a different host is a different system and stays separate (the two "Summit Health"s);
  - every R4 address stays connectable, including the ~110 that Brands doesn't list.
- **Rows:** one per organization name (brands and R4 names) and one per facility, each with the FHIR address to connect to, the facility's brand (`part_of`), a location ("Brighton, MA", or a system's states "NJ, PA") and `search_text`: the name's words and adjacent pairs, then the brand, city and state words.
- **Search** (`searchDirectory`): every query word must start a word (`like '% word%'`, a sequential scan of ~93,000 rows: 25–60 ms on Postgres 16 in testing, ~240 ms for a single generic word). Each address appears once, as its best match: names matching on their own first, then systems before clinics, then shorter names. Adjacent-word pairs make "MinuteClinic" and "NewYork-Presbyterian" match. If nothing matches every word, generic words ("health", "center", "medical", …) are dropped and it searches again, so "NYU Langone Health" finds "NYU Langone Medical Center".
- **Connect:** results link to `/api/epic/authorize?iss=<address>&org=<system name>`. A clinic connects under its system's name. The route accepts only an address in the directory (and only a name listed there), the sandbox, or an address on the live R4 list (`findConnectable`).
- **Before the first import**, and in sandbox mode, search and Connect behave exactly as before (R4 list, fetched and cached for a day).

Public reference data: no user_id, no row-level security, nothing from a person is stored.

## Rollout

- [x] Tables (`drizzle/0007_epic_directory.sql`), import job, search, connect route, result details (part of, location, other names)
- [x] Tests: merge rules (`brands.test.ts`), import, search and connect lookups on PGlite (`directory-store.test.ts`); real data checked on Postgres 16 (93,444 rows, ~6 s import, ~830 MB peak memory)
- [ ] After merging: in the Inngest dashboard (production environment), send `epic/directory.refresh-requested` and check the run's counts (about 1,500 organizations and 92,000 facilities). Search keeps using the R4 list until this has run.
- [ ] Confirm Northwell and New Jersey's Summit Health accept Wild Hearts' production client ID. Brands-only addresses haven't been tried with a real sign-in.

## Later

- A trigram index (`pg_trgm`) if search gets slow.
- Rank ties between same-named systems by size (facility count).
