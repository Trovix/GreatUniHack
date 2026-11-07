# Lecture Access

The current Earshot demo has a collapsible lecture-history sidebar, an inset frame and a speech bubble. Requests can be typed or dictated through the microphone button. **Cmd/Ctrl+K** moves the bubble to the centre and opens a typed request. **Claude through the user's Aside CLI** retrieves the actual Moodle transcript and notes, adapts a spoken opening lesson, and **ElevenLabs** narrates it. Live steps show the work as it happens. The separate deterministic site replays its economics lesson over 40 seconds; its saved lecture is already available in the sidebar under the lecture title.

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
npm run build:demo
LECTURE_ACCESS_ELEVENLABS_KEY_FILE=/absolute/path/to/private-elevenlabs-key npm run demo
```

Open **http://127.0.0.1:4320**. [Demo setup and behavior](DEMO.md).

---

## Earlier extension prototype

A Chrome MV3 extension and a paired local Node service for turning explicitly selected lecture audio, timed captions and aligned visuals into a source-grounded spoken explanation. The side panel and full workspace share the same interface. The design follows the provided design references, with local licensed fonts, an inset frame, a wave indicator and reduced-motion support.

**Current release status: prototype; full P0 verification is blocked.** Offline software and installed-extension fixture tests are implemented. ElevenLabs reference speech and source transcription were tested live. F1–F4b have not passed live multimodal transformation or audio comprehension review because live multimodal validation remains pending. No real Moodle session or target-user evaluation was available. See [VERIFICATION.md](VERIFICATION.md) for precise evidence and limits.

## Start locally without paid APIs

Run from this directory. Development dependencies include a local Node 22.21.1 runtime in `node_modules/node/bin`.

```sh
npm ci
export PATH="$PWD/node_modules/node/bin:$PATH"
node --version
npm run build
```

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this directory's `dist/extension` folder.
2. Copy the extension ID from Chrome. Start the service with that exact origin:

```sh
LECTURE_ACCESS_MODE=mock \
LECTURE_ACCESS_EXTENSION_ORIGIN=chrome-extension://YOUR_EXTENSION_ID \
npm run dev
```

3. Copy the random pairing token from `.data/pairing-token` into the extension's **Local service pairing token** field. The file is private (0600); keep it private. The API listens only on `127.0.0.1:4317`.
4. Use **Find → Use an authored synthetic source**, or import WAV/MP3, WEBVTT and PNG/JPEG/PDF files. In **Prepare**, review the source-time intervals, save the revision, then consent to **Prepare labelled mock transcript**. Review the limitations, separately consent to local speech, and choose **Listen**.

Mock mode preserves captions and explicitly says that visual meaning was not analysed. Local speech uses macOS `say`; it is not ElevenLabs. This mode demonstrates software behavior, not the main model-quality claim. Nothing autoplays. An explicit ready-queue snapshot can continue between lectures; new completions are not silently inserted.

## Capture the protected synthetic course

```sh
npm run fixture
```

Open `http://127.0.0.1:4318` in Chrome and press **Enter demo course**. Click the extension action on that course tab to grant `activeTab`. Bind the tab in **Find**, preview one visible section, and select its supported direct resources. The fixture's PDF/VTT/PNG/WAV routes require its HttpOnly browser-session cookie; a fresh HTTP client cannot retrieve them. The browser performs retrieval, and the backend never receives the login session. External recordings, action URLs, redirect/activity endpoints and unsupported resources require an explicit original-page/manual route.

This fixture is synthetic and does not constitute real Moodle verification. Do not import private university material without appropriate authorization and provider consent.

## Verify

```sh
export PATH="$PWD/node_modules/node/bin:$PATH"
npm run typecheck
npm run build
npm test
PLAYWRIGHT_BROWSERS_PATH=.cache/playwright npx playwright install chromium
npm run test:e2e
npm run verify:offline
```

The browser suite loads the actual unpacked extension into an isolated Chromium profile. It uses a real extension action to grant `activeTab`, exercises the authenticated fixture, manual import, timeline review, local mock speech, pause/question/resume, reload, source revisions, queue transitions and 360px layout. It also plays saved live speech artifacts if present. The tests do not call paid providers. Test servers use port 4317; stop your running demo service before the E2E suite.

## Provider configuration

Keys belong only in the service process, never the extension. Generic `OPENAI_API_KEY` is deliberately ignored. No key values are included in this project.

- `LECTURE_ACCESS_MODE=mock`: offline compiler and local Mac voice, with explicit mock labels.
- `LECTURE_ACCESS_MODE=live`: actual-image OpenAI Responses compiler and a separate bounded semantic audit. It requires an explicitly configured `LECTURE_ACCESS_OPENAI_API_KEY`. Default model: `gpt-4.1`. Live mode requires valid credentials and consumes provider usage.
- Live speech: `LECTURE_ACCESS_ELEVENLABS_API_KEY`, a verified stock `LECTURE_ACCESS_ELEVENLABS_VOICE_ID`, and `LECTURE_ACCESS_ELEVENLABS_VOICE_KIND=stock`. Default speech model: `eleven_multilingual_v2`; transcription: `scribe_v2`. Analysis, speech and optional transcription have separate UI consent.

`npm run verify:speech -- --run` is an ElevenLabs-only verifier. Set `LECTURE_ACCESS_ELEVENLABS_KEY_FILE` to a private key file owned by the current user (0600); it keeps a durable 240-second estimated TTS / one-file STT ledger, and never calls OpenAI. Existing submissions are not automatically repeated. Its three texts are **developer-authored references**, isolated under `verification/live-speech`; they are not golden outputs in production prompts or evidence of model transformation.

`npm run verify:live` defaults to a no-call explanation. Its explicit `--run` path requires separately configured credentials and an available request budget. It has a durable global 14-attempt multimodal cap and refuses to replay unknown outcomes.

## Implementation and limits

- Exact extension Origin and bearer pairing, loopback Host checks, strict CORS and no URL-proxy endpoint. The extension uses standard CORS rather than a broad loopback host permission, preserving its real Origin header.
- User-selected browser capture; isolated-world element identity; opaque resource IDs; same-origin, MIME/signature, redirect, size and decoded-path checks; revocation/navigation invalidation.
- Explicit timed alignment, including returns to an earlier state. Immutable source revisions, content hashes, persisted ordered jobs, cancellation/tombstones and rejection of late results.
- Typed evidence/dependencies/claims/narration; exact speech quotes; revision, timing, number/sign/unit and uncertainty checks. These are fallible screens, not semantic proof. Audit output is not human evaluation.
- One audio owner, source/adapted clocks, original-range playback, exact segment/offset resume, keyboard controls and local grounded retrieval. Q&A conservatively reuses approved current-segment material; it is not a general tutor.
- Local deletion follows references across current and archived revisions and shared blobs. Displaced audio is reclaimed after a committed manifest; startup collects orphaned blobs. Provider retention is not erased by local deletion.

The unpacked extension remains a local prototype. Side-panel action code exists and its handler is exercised by Chromium action tests; a human side-panel chrome activation check is still outstanding. Screen-reader checks with real assistive software, listening comprehension and target-user evaluation are also outstanding.

See [DEMO.md](DEMO.md), [VERIFICATION.md](VERIFICATION.md), and `verification/` for actual screenshots, audio, hashes, timings, request budgets and fixture reports.
