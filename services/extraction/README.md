# Local document extraction workbench

Authenticated users open `/app/wildcards/workbench`, select existing ready uploads and methods, and queue one immutable run per document/method. The web backend owns identity, sessions, document decryption, result encryption, cancellation, and reference-label versions. The VPS receives scoped execution grants, never database/R2 credentials or record encryption keys. Extraction is disabled unless all web settings are present.

## Per document FHIR view

Every ready file has a **FHIR** link in Documents and **View FHIR / Medplum data** on its detail page. `/app/wildcards/[id]/fhir` shows the latest completed extraction by default; its version picker and `runId` query select a specific completed run. This also works while workers are disabled. Files without a completed extraction still have a source DocumentReference.

The view produces a draft FHIR R4 collection with the source DocumentReference, a separate linked machine-summary DocumentReference when available, evidence-backed Observations, and software Provenance. Literal numbers/comparators and unambiguous ISO dates are mapped conservatively. Source fields and quotes are preserved; clinical codes, standardized units, final clinical status, and patient identity are not guessed. Partial extraction warnings remain visible. Exact repeated candidates are deduplicated within a run; different runs are not clinically reconciled.

`/api/wildcards/[id]/fhir?runId=…&download=1` downloads private `application/fhir+json`, checks ownership/readiness/completed-run membership, rejects a mismatch with the verified source fingerprint, and records a counts-only export audit. Original bytes are linked through the authenticated file endpoint, not embedded. The authored subset and internal references are validated locally; Medplum project profiles require separate validation. No information is sent to Medplum and no extracted fact is published to the timeline. Review, patient assignment, and a transport adapter remain separate work.

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
- `unlimitedocr`: experimental Baidu Unlimited OCR through a separate authenticated GPU service on the private network. It uses the same owner-selected jobs, scoped source access, isolated page renderer, redaction/synthesis, cancellation checks and encrypted immutable results as the other methods. There is no browser download/export path. Plain text still bypasses OCR.
- `docling`: an optional adapter requiring a separate image with Docling and predownloaded local artifacts at `DOCLING_ARTIFACTS_PATH`. It is not installed in the initial constrained CPU image. It fails instead of downloading models at runtime. Its block geometry is not reported as tight-word pixel coverage.

Every run includes rules, OpenMed, and combined PII spans; the combined text is the default summary input. A deterministic policy calculates age only from a single unambiguous ISO DOB and a supplied encounter date; ambiguous slash dates, conflicts, missing anchors, or impossible ages cause omission. A final detector/known-identifier scan withholds a summary on failure. Clinical quantitative extraction separately uses private original text through local inference, preserving source dates; each accepted candidate must quote source evidence containing its fields. These are experimental extractions, not verified clinical facts.

### Unlimited OCR private backend

The [official model](https://huggingface.co/baidu/Unlimited-OCR) is MIT licensed, approximately 6.7 GB in BF16, and has a finite 32K context. Its authors report strong document parsing benchmarks; that does not establish accuracy on our uploads. The official Transformers example targets NVIDIA/CUDA. Native AMD ROCm PyTorch also ran the initial synthetic numeric/checksum acceptance on this Windows machine (RX 9070, approximately 43 seconds and 8.25 GiB peak allocated VRAM). This small test is not clinical validation. Recheck the service after driver or runtime upgrades.

Run the GPU backend on the local inference machine, separately from the CPU/Iggy worker. Install Python 3.12 and the GPU vendor's compatible Torch/torchvision wheels in a dedicated environment. For AMD Windows, use the [official AMD installation instructions](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/windows/install-pytorch.html); the tested pair is Torch 2.9.1+rocm7.2.1 / torchvision 0.24.1+rocm7.2.1. Do not install CUDA wheels on an AMD host. Then, from the repository root using that environment's Python:

```powershell
python -m pip install -r services/extraction/requirements-unlimited-ocr.txt
python services/extraction/prepare_unlimited_ocr.py services/extraction/models/unlimited-ocr
```

Preparation acquires official revision `8249d20b2822a7d8a4c22c8d8c9069b5ac36bda3`, hashes the model/configuration/tokenizer files, and applies two narrow custom-code changes: accept PIL images directly in memory and replace Python `eval` of model output with literal parsing. It is idempotent and fails if prepared hashes have changed. Startup verifies all recorded files, loads only local safetensors/custom code, and disables library downloads/telemetry. The runtime blocks Python outbound socket connections after loading. Run it behind the existing private-network firewall as well; this is not a claim of OS-level sandbox isolation.

Create a dedicated random credential file on the GPU host without printing its contents. Keep it outside tracked files. The same value belongs only in the gateway's protected environment; the worker and web app never receive it. Start the service with:

```powershell
$env:UNLIMITED_OCR_MODEL_DIR = 'C:\absolute\path\to\models\unlimited-ocr'
$env:UNLIMITED_OCR_TOKEN_FILE = 'C:\absolute\private\path\ocr-token'
$env:UNLIMITED_OCR_HOST = '127.0.0.1' # use this machine's private/Tailscale IP for the VPS gateway
$env:UNLIMITED_OCR_PORT = '8091'
$env:UNLIMITED_OCR_DEVICE = '0' # one explicit GPU; no changes to other inference services
python -B services/extraction/unlimited_ocr_server.py
```

The bind address must be an explicit private IP (wildcard/public binds are rejected); restrict network access to the extraction gateway. Prefer a Tailscale address for cross-host traffic so the HTTP connection travels inside its encrypted tunnel. Do not publish this port publicly. `GET /ready` requires the credential and returns only model/runtime identity; `POST /ocr` accepts one bounded PNG raster plus the expected runtime fingerprint. Pixels and output remain in RAM, no document temp files are created, and stdout/stderr/access/error logs are suppressed. One GPU call runs at a time; a concurrent request returns 503. Generation has an 8,192-output-token limit and a 120-second soft budget (an in-flight model step can exceed it); reaching either limit fails instead of saving truncated text. Cancellation/revocation is checked by the gateway before and after each OCR call, so in-flight compute can continue but its late output cannot be accepted. HTML table rows/cells are retained without expanding merged-cell spans; predicted block coordinates are not reported as tight word boxes, confidence, or visual coverage.

Add these settings only to the extraction gateway's protected `.env.gateway` (not web/client or coordinator settings):

```dotenv
EXTRACTION_UNLIMITED_OCR_URL=http://<gpu-host-private-or-tailscale-ip>:8091
EXTRACTION_UNLIMITED_OCR_KEY=<dedicated-random-credential-at-least-32-characters>
```

These settings are optional: existing methods do not depend on this service. A selected Unlimited OCR job retries service outages under the existing queue policy; it never silently falls back to another parser. Its encrypted manifest includes the model revision and a fingerprint covering prepared assets, runtime code, versions, GPU and generation policy. A backend change mid-run fails the request rather than mixing environments.

Roll out the web schema validator/UI first, then the updated gateway/worker while the extraction coordinator is idle, then validate the private service. Finally append `unlimitedocr` to the web deployment's existing `EXTRACTION_METHODS`. Keep the option disabled until that entire path is ready: older workers do not understand this method. No database migration or new required web environment variable is needed. Queue experiments through the workbench's **Unlimited OCR (experimental)** checkbox; the native/Tesseract bulk-backfill policy is unchanged. `stage_vps.py` is initial provisioning and rewrites gateway settings, so preserve/reapply these optional entries if that script is reused.

Synthetic integration checks: `python -m unittest discover -s services/extraction -p 'test_*.py'`; the web suite additionally checks queue enablement, ownership, scoped cancellation, method identity and encrypted result custody for this method.

The actual parser → scoped gateway → authenticated GPU service path also passed the synthetic four-number/checksum probe on the RX 9070 XT in approximately 17.7 seconds. The HTTP runtime explicitly selects the configured GPU on each request thread. No uploaded documents were used for either acceptance check; source-document quality remains unmeasured.

The worker handles up to 100 pages / 25 MB, bounds page pixels, and rejects oversized outputs rather than silently truncating them. Version 3 replaces the old 60,000-character inference cutoff with up to eight 20,000-character chunks per task, 400-character overlap within long pages, and source page labels. Redacted summary and private original-text measurement tasks remain separate and are interleaved. Exact duplicate measurement candidates are deduplicated; every accepted field still requires a source quote. A final local synthesis combines validated partial summaries and passes its own privacy gate. Empty text never generates findings.

Inference checks a ten-minute soft time budget before each call; an in-flight call can consume its existing timeout. Chunk/output/time limits and invalid chunks are explicit warnings, and per-task attempted/total chunk counts are recorded in the manifest outside the environment fingerprint. A partial summary input always withholds the document-level summary; valid measurements from processed chunks remain available with incompleteness flags. Earlier runs retain their original limits and provenance. Medical-image tagging, learned page routing, Medplum export, and wiki generation remain subsequent work.

## Evaluation

Reference versions are immutable and encrypted. Review text against the original, select identifier spans, and supply complete measurement tuples for the labeled pages. Editing the guided reference text clears its spans. UTF-16 browser selections are converted to Unicode scalar offsets for Python parity. Explicit train/validation/test splits and exported reference/run IDs support later optimization; no automatic hill-climber is enabled.

Scores report normalized token multiset precision/recall, word error rate (with a bounded edit-distance budget), PII label+surface multiset precision/recall, exact measurement tuple precision/recall (unit case preserved), age accuracy, and known-identifier substring matches in summaries. PII comparison across corrected reference text and parser text is an end-to-end measure: OCR omissions affect recall too. Leakage substring matches need review and are not proof of anonymity. Missing gold labels and empty denominators remain unscored. Partial-page references never imply whole-document accuracy.

Visual coverage is the fraction of rendered non-white foreground pixels covered by extracted word boxes. It includes figures/rules in the denominator, is sensitive to scan background and geometry, and is **not** text accuracy. Without word geometry it remains unscored. The visual debugger can switch between each compared run and their combined evidence, and between word geometry, low-confidence words, suspected uncovered foreground, disagreements and table/image regions. The combined view preserves conflicting words; it is not a corrected transcript. Older runs require a rerun for new diagnostics. Overlay display is explicitly capped at 4,000 regions.

`/app/wildcards/benchmark` aggregates up to 200 latest owner-scoped runs, grouped by method, input-class proxy and environment fingerprint. Its API decrypts results only server-side and returns numerical metrics and opaque run/file IDs, never source text. The cohort is selected uploads, not a representative sample. Reviewed-reference accuracy is distinct from visual coverage and table detection counts. Reference labels remain encrypted.

Run manifests include dependency versions, parser configuration, worker image, model revision when available, privacy policy and an environment fingerprint. Reruns create new immutable child runs with the same document/method/date and record the requested parent fingerprint. They use currently installed tools, explicitly flagging changed/unknown environments rather than claiming exact reproduction from model aliases alone.

Permanent worker failures report a finite public code for source, parsing, privacy, inference, result assembly or completion. Exact internal limit sentinels distinguish page, pixel, text, source-size and result-size limits; memory and OCR timeout failures have their own codes. Unknown exception messages remain private and are never serialized. The HTTP boundary rejects arbitrary diagnostic strings/fields and persistence applies its own allowlist. Transient service failures retain the existing backoff and `service_unavailable_retrying` status. Old workers may omit the code. Deploy the web API before upgrading workers that send it; the older strict API rejects the new field. Historical generic failures cannot be retroactively classified, and an externally killed worker cannot send a reason code.

`synthetic_corpus.py` authors 13 one-page known-answer stress fixtures; `synthetic_runner.py` scores prose, reading order, numbers, table cells and chart labels. The synthetic-only numeric snapshot in `src/lib/extraction/synthetic-results.json` records 52 runs across native, Tesseract, RapidOCR and Qwen3-VL-4B. OCR methods share canonical rasters. Runtime hardware differs, RapidOCR synthetic coverage uses line boxes, and the small repeated templates do not establish clinical or uploaded-document performance. Chart point evaluation covers only one simple plot and does not validate units. PII integration acceptance is a separate synthetic experiment described below.

## Synthetic acceptance, 2026-10-14

`acceptance.py` runs a wholly synthetic one-page clinical PDF through the real isolated Iggy daemon, actual offline OpenMed weights, and the existing private Qwen endpoint. Its fake web authority contains no production database or document access. It verifies source hashes and records counts/scores only under the private acceptance-state directory.

Initial native and Tesseract runs both achieved 100% token precision/recall, removed the synthetic name/DOB/ID, calculated encounter age 44, preserved two quantitative results, and produced an accepted summary plus two measurement candidates. Strict PII precision/recall: rules 100%/100%, OpenMed 50%/33.3%, combined 100%/100%. End-to-end elapsed time: approximately 78 seconds native and 56 seconds OCR, including inference/model startup. These tiny synthetic results validate integration and illustrate layering; they do not estimate performance on uploaded documents.

Uploaded-document benchmarks require the new web API/schema rollout and an authenticated owner's selected jobs. Do not queue arbitrary users' documents through privileged database access or copy their content into Git, agent prompts, or online model APIs.

## Native-first bulk backfill

The authenticated progress-page action snapshots only the owner's ready documents that have never had an extraction run. Repeated requests do not duplicate enrollment. Every enrolled job is stored durably as `waiting`; the coordinator admits at most20 queued/running jobs globally at a time, and one isolated worker executes at a time. Waiting admission requires the coordinator to advertise `native-ocr/v1`, so an older runtime cannot accidentally process the new policy. Migration `0017_durable_extraction_backfill` adds an explicit owner-authorized `durable` flag. New backfills and their reruns continue across sign-out/session expiry. Existing jobs retain their previous authorization until the owner upgrades them through the progress page. That action can explicitly resume cancelled backfill jobs; jobs cancelled by the owner under the new policy and terminal failures are preserved. Each attempt still has a 30-minute grant, and account/document deletion or explicit cancellation revokes access. The migration does not silently extend any existing authorization.

Each backfill run requests native extraction with sealed `pipeline: native-ocr/v1` configuration. UTF-8 text bypasses OCR. PDFs retain native text/tables/figures; only scan-like, empty ink-bearing, sparse image-header, or low-coverage image/header pages receive Tesseract OCR. Routing thresholds are heuristics, not accuracy scores. A native-parser failure falls back to OCR unless it is a hard input/resource limit or service outage. OCR fallback retains the native attempt, its separately redacted text and word/table/image geometry, and a finite fallback reason in the encrypted immutable result. Per-page diagnostics identify the selected text engine; manifests record the pipeline, routing configuration and all existing tool/model fingerprints.

Infrastructure outages retain exponential retry without an attempt cap for durable backfills. Other processing failures retry up to three total attempts; known hard input/resource limits stop immediately. Container exit137 is retried at most three times, then marked `resource_limit`. Partial inference remains explicitly flagged/withheld under the existing policy. Failed files remain visible and can be rerun as new immutable runs. Existing 100-page, pixel, text, source and result-size bounds are unchanged; backfill enrollment does not guarantee every document can fit them.
