# Verification — 7 November 2026

## Current request demo

The rebuilt `apps/demo` entry point completed an actual signed-in Moodle retrieval through Claude Sonnet 5.5 on Aside, read a real lecture transcript and matching notes/slides, adapted an opening lesson, and generated **330.188 seconds of real ElevenLabs narration**. Browser playback, pause, adapted transcript, source links, persisted result recovery, keyboard entry, initial blank screen and mobile layout were checked. No course transcript, slides or generated private lecture audio are committed; they remain in ignored local `.data/demo/`. OpenAI is not used in this demo pipeline.

`npm run typecheck` and `npm run build:demo` pass. `npm run test:demo -- --prepared` checks the running UI and already-prepared real audio without new provider calls. The requested output is a labelled opening teaching lesson, not the complete two-hour recording. The earlier extension benchmark results below describe the previous prototype, not this demo.

## Earlier extension prototype

**Release verdict: full P0 is not verified.** The local prototype and its offline software paths are implemented and tested. Live OpenAI transformation, actual Moodle capture and human audio-comprehension review remain open.

## Automated results

| Check | Observed result | Evidence |
|---|---|---|
| Node runtime | Task-local Node 22.21.1 | `node_modules/node/bin/node` |
| TypeScript | Passed, including app, scripts and tests | `npm run typecheck` |
| Production extension build | Passed | `verification/build.log`, `dist/extension` |
| Offline behavioral suite | 161 passed, 0 failed, 0 skipped | `verification/unit-results.json` |
| Installed-extension Chromium suite | 8 passed, 0 failed, 0 skipped, 0 flaky | `verification/browser-results.json`, `verification/browser.log` |
| Current dependency advisory check | 0 reported vulnerabilities | `verification/dependency-audit.json` |
| F1/F2/F3/F4a/F4b mock compilation | All deterministic checks passed; no live semantic verdict | `verification/offline/<fixture>/report.json` |

The build reports a large-bundle advisory (PDF support and the schema library) and third-party annotation warnings; these are not suppressed or represented as failed compilation. The Chrome test runtime is task-local Chromium 158 / Playwright 1.65.0. Fixture DOM tests and installed-extension tests are different checks.

Offline tests cover actual media bytes, VTT/timeline errors, half-open state lookup and slide returns, quotes/IDs/revisions, numerical signs/units, uncertainty/conflict disclosures, malformed provider output, rejected/unknown requests and bounded retries, exact Origin/bearer/Host checks, input limits, persistence, cancellation, late results, shared-blob deletion and failed atomic writes. The buffer-ownership regression confirms worker parsing does not detach provider audio bytes. Dependency validation rejects a future-only state even if a narration segment has a broad source range.

Installed-extension tests cover genuine action-granted `activeTab`, authenticated resource retrieval and an unauthenticated negative control, unsafe/unselected content, stale IDs/navigation, website bridge rejection, manual file import, reviewed alignment, explicit mock preparation, native local speech, keyboard actions, question-box Space, Escape, question/resume, paused reload, queue transitions and original audio with reused asset IDs. Axe checks passed on the tested Prepare and Listen states. Responsive 360px screenshots and no-horizontal-overflow checks passed; reduced-motion mode was exercised. These checks are not screen-reader certification or target-user evaluation.

The final combined browser run and a narrow API regression also check that a fresh speech request reuses the saved checked audio without a provider call, marks it cached and preserves the original provider label. API and manual-demo tests cover this behavior.

## Live ElevenLabs evidence

The existing private ElevenLabs credential was used only against ElevenLabs over HTTPS. Read-only preflight verified active quota, an available stock voice and supported TTS models. It did not change an account or purchase credit.

| Artifact | Source of spoken text | Actual audio duration | Result |
|---|---|---:|---|
| `live-speech/F1-reference.wav` | Developer-authored synthetic reference, covering the F1 meanings | 94.37 s | Generated, independently decoded, fetched through paired API, Chromium playback time advanced |
| `live-speech/F2-change-reference.wav` | Developer-authored fewer-buyers / 3 and £3 reference | 20.90 s | Generated, decoded, fetched and played |
| `live-speech/QA-reference.wav` | Developer-authored grouped fraction and restriction | 13.65 s | Generated, decoded, fetched and played |
| `live-speech/source-F1-stt.vtt` | Actual 60-second synthetic F1 source WAV | 60 s input | Live `scribe_v2` transcription returned timed captions |

Provider: ElevenLabs; TTS model: `eleven_multilingual_v2`; stock voice: Bella (`hpp4J3VqNfWAUOO0d1Us`). Character-level alignment, audio hashes, observed request timings, model and voice IDs and browser playback evidence are saved in the adjacent JSON reports.

**Actual submissions:** 3 successful TTS requests and 1 successful STT request, no retries. Conservative TTS reservation was **201 / 240 estimated seconds**; returned speech totals about 128.92 seconds. STT used one 60-second file. The durable ledger is `verification/live-speech/budget.json`. Monetary cost is unmeasured.

The six returned STT sentences have the same 85 words in the same order as the authored captions after ignoring punctuation and case. This is a narrow textual comparison on synthetic source speech, not an audio-only comprehension study or a general transcription-accuracy claim. The returned timing ranges differ appropriately from the broader authored caption windows.

**Important limit:** these live narration texts are explicit developer references, not output of a live visual-language compilation. No full OpenAI → compiler audit → ElevenLabs semantic success is claimed. Human listening for signs, values, grouping and comprehension remains **not performed**. Playback advancement is software evidence, not proof that a person heard or understood the speech.

## Fixture semantic verdicts

Each fixture has source hashes/revision, a complete mock ledger/script, software errors, processing time and explicit live-blocked status in `verification/offline/<id>`. Those mock outputs preserve captions and disclose unanalysed visual meaning. They cannot pass the live semantic gate.

| Fixture | Authored input checks | Live transformation / critical-meaning verdict |
|---|---|---|
| F1 | Chart/equation images, source speech, captions and nonmonotonic timeline present; rendered images inspected | Blocked. K1–K12 are not verified in model-generated speech. Reference narration does not substitute for this gate. |
| F2 | Actual decreased-demand images and speech differ from F1; 3/£3 source point inspected | Blocked. No live generated F2 adaptation/audio comparison. |
| F3 | Two equally marked options with no selecting pointer; real image inspected | Blocked. Mock limitations and local answer refusal tested; live uncertainty behavior unverified. |
| F4a | Actual conflicting speech; chart remains unchanged | Blocked. Conflict disclosure tested with mocks; live reconciliation behavior unverified. |
| F4b | Illegible formula raster and PDF text-layer checks; blurred image inspected | Blocked. No live test proving refusal to reconstruct the known formula. |

No fixture answer manifest is imported by production prompts. The source loader reads authored source files; compiler/audit requests contain the selected source evidence, actual images and candidate output. Provider-boundary tests inspect this. Structural/lexical validation and a model audit remain fallible.

## Open gates and limits

- **Live multimodal:** blocked: no live multimodal verification run was completed within the available API budget. No application multimodal compile/audit requests were submitted. Five fixture live scripts, critical-item review and generated-audio comprehension cannot be claimed.
- **Actual Moodle:** **[blocked: no authorised real-Moodle capture verification]**. The passing authenticated fixture does not satisfy this P0 requirement.
- **Side-panel chrome:** manifest/action handler and shared side-panel entry are implemented. The real action is automated; a separate human check of Chrome's side-panel activation UI remains outstanding. The full workspace tab is the tested UI.
- **Assistive technology and people:** no VoiceOver/NVDA session, blind/low-vision user study, expert accessibility certification or human audio-only comprehension check was performed.
- **Scope:** recordings requiring external-player authentication/DRM and general course crawling remain out of scope. Questions use conservative local source retrieval, not an unrestricted conversational tutor.

## Reviewable artifacts

- Screenshots: `verification/screenshots/workspace-desktop.png`, `workspace-narrow.png`, `player-desktop.png`, `player-narrow.png`, `offline-manual-demo.png`, `session-protected-course.png`.
- Local mock narration: `verification/offline/F1/mock-narration.wav` (94.60 seconds; native Mac voice; not ElevenLabs or a verified visual transformation).
- Live speech/transcription and request ledger: `verification/live-speech/`.
- Critical-item verdicts and the unperformed comprehension question set: `verification/critical-meaning-review.json`.
- Source fixtures and authored media: `fixtures/`.
- Commands and local setup: [README.md](README.md). Walkthrough: [DEMO.md](DEMO.md).

No public deployment, hackathon submission, account changes or private university uploads were performed. The product is named **Lecture Access**.
