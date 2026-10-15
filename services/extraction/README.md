# Local document extraction workbench

Authenticated users open `/app/wildcards/workbench`, select existing ready uploads and methods, and queue one immutable run per document/method. The web backend owns identity, sessions, document decryption, result encryption, cancellation, and reference-label versions. The VPS receives scoped execution grants, never database/R2 credentials or record encryption keys. Extraction is disabled unless all web settings are present.

## Web configuration and migration

Migration `0013_document_extraction` adds three owner-scoped tables. File deletion cascades runs, queue metadata, and reference labels; all text, results, labels, and encounter-date configuration are encrypted using the existing per-user keys. The explicit web dispatch context applies only to the queue metadata table. No document contents or labels enter that context.

- `EXTRACTION_ENABLED=1` enables queue creation and worker APIs; unset/0 disables them.
- `EXTRACTION_METHODS` optionally lists enabled adapters; defaults to `native,tesseract`. Enable `rapidocr`/`vision`/`docling` only after their private runtimes and assets pass acceptance. Unavailable methods are disabled in the UI and rejected server-side.
- `EXTRACTION_COORDINATOR_TOKEN_HASH` is the SHA-256 verifier of a dedicated coordinator credential. Raw credential remains on the VPS.
- `EXTRACTION_GRANT_KEY` is a random, independent, web-only secret of at least 32 characters. Rotating it prevents claim replay with old grants; explicitly cancel existing work during rotation.

Use the normal reviewed deployment/migration path. Do not copy production secrets into preview or the VPS. Reference labeling and old results remain accessible to their owner with workers disabled. Source bytes stream only after the original ciphertext is completely authenticated. Each attempt expires after 30 minutes; cancellation, logout, expired sessions, and deleted/deleting source documents deny further protected calls. A running native parser may continue until its next checkpoint or the coordinator stops its container; already delivered plaintext cannot be recalled.

### Outage recovery

Migration `0015_extraction_retries` adds durable attempt counts and retry timestamps. Transient transport errors, HTTP 408/429/5xx, and interrupted workers requeue the same job, with a fresh scoped grant per attempt. Backoff starts at 30 seconds and doubles to a 30-minute cap. Infrastructure retries have no attempt limit while the initiating session remains valid; logout/session expiry cancels them. Invalid documents, invalid model JSON, and privacy rejection do not trigger unbounded infrastructure retries. A model outage cannot produce a completed result with silently missing inference.

The coordinator waits for the gateway's private `/ready` check before claiming work. Queued work stays in Postgres during either server's outage. On VPS recovery, Compose restarts the coordinator/gateway and Iggy; the coordinator resumes active monitoring, requeues interrupted workers, and recovers expired leases. Delayed jobs do not block other eligible jobs. Old attempt grants cannot complete or fail a newer attempt. No document contents enter readiness responses or retry metadata. Existing completed results (including older partial results) are immutable and must be explicitly rerun; this migration does not rewrite benchmark history.

## VPS preparation

Dedicated deployment root: `/opt/wildhearts-extraction`. Existing production chat and Matrix/Medplum deployments are not modified.

1. Acquire model assets with `download_model.py` **before** processing documents. It records the Hugging Face commit. Assets are ignored by Git; verify the selected model's license. Build the worker with `docker build --target worker -t wildhearts-extraction-worker:v1 -f services/extraction/Dockerfile .`. The image contains CPU Torch, native PDF tools, Tesseract, and OpenMed 3.0.0. Runtime HF downloads and telemetry are disabled. Iggy additionally denies direct worker network egress.
2. Clone Iggy at commit `73384230ce3f623c9a6e20c4d2bf280d8cae7e12`. Run `prepare_iggy.py` on that dedicated checkout, then run its API/Docker/runner tests and build `cmd/iggyd`. This adaptation retains the existing `health-chat/v1` transport name, increases document limits (1 GB RAM, 1 CPU, 192 MB tmpfs, 30 minutes), and namespaces Docker labels/network names under `whdoc`. Both daemons' startup sweeps therefore stay separate. Never apply this adaptation to the production chat daemon.
3. Place the checkout/binary under the deployment root's `iggy/`. `stage_vps.py` creates protected, separate gateway/coordinator environment files, a dedicated Iggy token, and a dormant extraction Iggy daemon pinned to the worker image. It copies only the existing private inference endpoint/key/model settings from the deployed chat gateway; it never prints their values. The coordinator remains stopped.
4. Build/start only the extraction gateway with the supplied Compose file. It publishes no host ports. Iggy connects it to each isolated worker network. The coordinator is a separate container and receives no inference key; the gateway receives no coordinator/control token.
5. Configure the web-only settings, deploy the additive migration/APIs, then start the extraction coordinator. It processes one job at a time. Monitor disk headroom: the shared 4 GB VPS has limited room for additional model images. Iggy refuses work at its disk threshold.

`stage_vps.py` refuses to repin a daemon with active document workers. Model/image changes require an idle rollout. Stop the extraction coordinator before upgrades. Keep every plaintext intermediate in bounded tmpfs; results return to the web backend for encryption. Docker worker and gateway logs are disabled. Do not inspect process output or exception bodies from real-document runs.

## Methods and current limits

- `native`: pdfplumber text/word coordinates/tables, with PDFium page rendering. Images without text are inventoried, not silently OCRed.
- `tesseract`: rendered-page OCR, with word geometry and preserved line order. This also handles image uploads.
- `rapidocr`: optional `worker-neural` image target with pinned RapidOCR/ONNX Runtime and explicitly verified bundled PP-OCRv6 model hashes. CPU execution inside Iggy; no runtime downloads. The desktop DirectML experiment is a separate synthetic benchmark, not the production execution provider.
- `vision`: page transcription through a separately configured `EXTRACTION_VISION_MODEL` on the same private inference endpoint. No remote image URLs or provider fallback. The current staged endpoint has no verified vision profile; leave this method disabled until tested.
- `docling`: an optional adapter requiring a separate image with Docling and predownloaded local artifacts at `DOCLING_ARTIFACTS_PATH`. It is not installed in the initial constrained CPU image. It fails instead of downloading models at runtime. Its block geometry is not reported as tight-word pixel coverage.

Every run includes rules, OpenMed, and combined PII spans; the combined text is the default summary input. A deterministic policy calculates age only from a single unambiguous ISO DOB and a supplied encounter date; ambiguous slash dates, conflicts, missing anchors, or impossible ages cause omission. A final detector/known-identifier scan withholds a summary on failure. Clinical quantitative extraction separately uses private original text through local inference, preserving source dates; each accepted candidate must quote source evidence containing its fields. These are experimental extractions, not verified clinical facts.

The initial worker handles up to 100 pages / 25 MB, bounds page pixels, and rejects oversized outputs rather than silently truncating them. Local summary/measurement input is limited to 60,000 characters; larger documents retain parsing results with a warning and withheld summary. Multi-stage/chunked synthesis, medical-image interpretation, learned page routing, Medplum export, and wiki generation remain subsequent work.

## Evaluation

Reference versions are immutable and encrypted. Review text against the original, select identifier spans, and supply complete measurement tuples for the labeled pages. Editing the guided reference text clears its spans. UTF-16 browser selections are converted to Unicode scalar offsets for Python parity. Explicit train/validation/test splits and exported reference/run IDs support later optimization; no automatic hill-climber is enabled.

Scores report normalized token multiset precision/recall, word error rate (with a bounded edit-distance budget), PII label+surface multiset precision/recall, exact measurement tuple precision/recall (unit case preserved), age accuracy, and known-identifier substring matches in summaries. PII comparison across corrected reference text and parser text is an end-to-end measure: OCR omissions affect recall too. Leakage substring matches need review and are not proof of anonymity. Missing gold labels and empty denominators remain unscored. Partial-page references never imply whole-document accuracy.

Visual coverage is the fraction of rendered non-white foreground pixels covered by extracted word boxes. It includes figures/rules in the denominator, is sensitive to scan background and geometry, and is **not** text accuracy. Without word geometry it remains unscored. The visual debugger can switch between each compared run and their combined evidence, and between word geometry, low-confidence words, suspected uncovered foreground, disagreements and table/image regions. The combined view preserves conflicting words; it is not a corrected transcript. Older runs require a rerun for new diagnostics. Overlay display is explicitly capped at 4,000 regions.

`/app/wildcards/benchmark` aggregates up to 200 latest owner-scoped runs, grouped by method, input-class proxy and environment fingerprint. Its API decrypts results only server-side and returns numerical metrics and opaque run/file IDs, never source text. The cohort is selected uploads, not a representative sample. Reviewed-reference accuracy is distinct from visual coverage and table detection counts. Reference labels remain encrypted.

Run manifests include dependency versions, parser configuration, worker image, model revision when available, privacy policy and an environment fingerprint. Reruns create new immutable child runs with the same document/method/date and record the requested parent fingerprint. They use currently installed tools, explicitly flagging changed/unknown environments rather than claiming exact reproduction from model aliases alone.

`synthetic_corpus.py` authors 13 one-page known-answer stress fixtures; `synthetic_runner.py` scores prose, reading order, numbers, table cells and chart labels. The synthetic-only numeric snapshot in `src/lib/extraction/synthetic-results.json` records 52 runs across native, Tesseract, RapidOCR and Qwen3-VL-4B. OCR methods share canonical rasters. Runtime hardware differs, RapidOCR synthetic coverage uses line boxes, and the small repeated templates do not establish clinical or uploaded-document performance. Chart point evaluation covers only one simple plot and does not validate units. PII integration acceptance is a separate synthetic experiment described below.

## Synthetic acceptance, 2026-10-14

`acceptance.py` runs a wholly synthetic one-page clinical PDF through the real isolated Iggy daemon, actual offline OpenMed weights, and the existing private Qwen endpoint. Its fake web authority contains no production database or document access. It verifies source hashes and records counts/scores only under the private acceptance-state directory.

Initial native and Tesseract runs both achieved 100% token precision/recall, removed the synthetic name/DOB/ID, calculated encounter age 44, preserved two quantitative results, and produced an accepted summary plus two measurement candidates. Strict PII precision/recall: rules 100%/100%, OpenMed 50%/33.3%, combined 100%/100%. End-to-end elapsed time: approximately 78 seconds native and 56 seconds OCR, including inference/model startup. These tiny synthetic results validate integration and illustrate layering; they do not estimate performance on uploaded documents.

Uploaded-document benchmarks require the new web API/schema rollout and an authenticated owner's selected jobs. Do not queue arbitrary users' documents through privileged database access or copy their content into Git, agent prompts, or online model APIs.
