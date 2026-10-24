# Guided fictional patient demo

Any verified, signed-in Wild Hearts account can open `/demo`. No separate demo email or password is required. The first visit offers **Open guided demo**, which creates a private fictional workspace for that account. Later visits go directly to the guide while demo mode is selected. **Return to my account** exits demo mode without signing out.

Alex Morgan is an entirely invented 34-year-old with biopsy-confirmed eosinophilic esophagitis, persistent bloating, fatigue and an unresolved flushing evaluation. No real patient or clinician is represented. MCAS is explicitly unconfirmed.

## Present on wildheartsai.com

1. Sign in to your normal account at **https://www.wildheartsai.com**.
2. Open **https://www.wildheartsai.com/demo**, or select **Demo** in the app navigation.
3. Click **Open guided demo**. The fictional chart is created automatically; no local server or separate demo password is needed.
4. Follow the six chapters below. **Reset demo** prepares your fictional chart for another presentation.
5. Select **Return to my account** to resume your personal record without signing out.

If `/demo` returns 404, the deployment does not include the demo or the server's `DEMO_ENABLED` flag is off. The hosted setup below is for the operator who deploys the site.

## Start locally (development only)

1. Use the existing local `.env.local`, local database and encryption keys.
2. Set `DEMO_ENABLED=1` and run `npm run db:migrate` (including migration 0019).
3. Start `npm run dev`, sign in with your normal account and open **http://localhost:3000/demo**. Use `npm run db:seed` for the ordinary local test account if needed.
4. Click **Open guided demo**. The fictional chart is populated automatically in a separate workspace.

`npm run demo:seed` remains available for the older dedicated presenter account, but it is no longer required for normal demo access. Its existing credentials are preserved for compatibility.

## Hosted setup (operator)

Deploy migration 0019 and set `DEMO_ENABLED=1`. The migration adds a nullable parent-session reference and extends the existing chat session fence; it is backward compatible with ordinary sessions and the previous deployment. No separate demo credentials, account-seeding command, new encryption keys, or Medplum credentials are needed.

1. Sign in to your normal account at **https://www.wildheartsai.com**.
2. Open **https://www.wildheartsai.com/demo**, or select **Demo** in the app navigation.
3. Click **Open guided demo**. Use the six chapters; **Reset demo** prepares your fictional chart for another presentation.
4. Select **Return to my account** to resume your personal record. The original login cookie remains unchanged.

The demo remains behind a verified login. The page returns 404 when `DEMO_ENABLED` is off. The mode cookie only selects the current login's own workspace; it cannot select a different person's account. Each workspace has separate encrypted records, chat conversations, uploads and summaries. It has no sign-in password or browser authentication token. Internal chat work uses a child session whose expiry and revocation are tied to the real login; logout deletes the child session, and an expired or unverified parent cannot authorize work. Live health-system connections are blocked in demo mode.

Prepared answers remain available without the model. **Try this in live chat** uses the actual model and the workspace's fictional records when the existing `CHAT_ENABLED=1` configuration and worker backend are available. It does not query the person's personal chart. Signing in alone is not a per-day model quota; the existing server concurrency, request and execution limits still apply.

## A 6–8 minute presentation

1. **Meet Alex.** Explain the three portals and nine-month story. Establish what is confirmed versus still uncertain.
2. **Bring it together.** Replay the sample sync. Show clinic counts, search for a biopsy, and open its fields. The sample importer uses real normalization, version-aware diffing, note storage and per-user encryption. The main record timeline and live chat tools can read these same rows.
3. **Ask Holo.** Choose history, current status, visit preparation, diary patterns and research examples. Open the source cards. Prepared answers and displayed steps are explicitly scripted for reliable presentations; no tool calls are represented as live. “Try this in live chat” prefills the question without submitting it; the actual model, tools, transcript and source receipts work normally if the chat service is enabled. Response time and wording can vary.
4. **Add a document.** Download the one-page PDF and select it with the file picker, or use the one-click loader. Review the prepared extraction and approve the mapping. Only the byte-identical provided fixture is accepted: arbitrary uploads cannot create the canned clinical findings. The two mapped resources are really added to the encrypted chart and linked through `derivedFrom`. Repeating the upload does not duplicate them. Use Documents for real OCR/extraction and arbitrary files.
5. **Prepare for care.** Show the three upcoming fictional appointments and download the GI visit brief. Switch between the sample portal inbox and email. “Simulate sending” changes only the presentation; no portal message, email or appointment is sent or created externally.
6. **Check the evidence.** The local demo library contains authored summaries linked to the ACG EoE guideline discussion and AAAAI MCAS evaluation discussion. These are general research background, not evidence of Alex's personal diagnosis. They do not modify the separately hosted production research wiki.

The reference date is anchored when seeded, so all chart dates agree. **Reset demo** restores the synthetic chart with a new reference date, removes the sample document mapping and restarts the guide. Reset only deletes sources with the reserved demo URLs owned by the demo user. It does not delete real accounts, change account credentials or clear ordinary chat history. The prepared walkthrough remains available without the model, email provider, Epic, OCR worker or R2.

## Honest backend boundaries

- The three clinic feeds are fixtures, not live Epic connections. They have no token rows and are stored as disconnected snapshots so scheduled refresh jobs cannot call fictional endpoints.
- The PDF extraction is a prepared replay, explicitly labeled throughout. The original generated PDF remains downloadable; page 1 is the provenance for the mapped finding.
- `/api/demo/fhir?type=Observation&q=ferritin` searches only the current login's selected fictional workspace and returns a FHIR-shaped Bundle. It is a bounded local demonstration, not a full FHIR server or a Medplum deployment. The UI shows a Medplum handoff preview; no Medplum write occurs.
- Live chat queries the same record store, with existing RLS, owner checks and saved tool receipts. The local demo research summaries are used by prepared examples; the live agent uses its separately configured research corpus.

## Source background

- ACG: [A Look at the Updated ACG Eosinophilic Esophagitis Clinical Guidelines](https://gi.org/journals-publications/ebgi/eluri_feb2025/), 2025.
- AAAAI: [MCAS, evaluation and diagnosis](https://www.aaaai.org/allergist-resources/ask-the-expert/answers/2022/mcas), 2022.

The clinical scenario, diary and message text are invented, and the prepared answers are not evidence of clinical accuracy.
