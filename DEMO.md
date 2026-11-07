# Earshot demo

Start with your lecture history in a collapsible sidebar and the speech bubble at the bottom left inside the inset frame. Press **Cmd+K** (Mac) or **Ctrl+K**, or click the bubble. It moves to the centre and reveals the request field.

Example: **Teach me the content from my latest microeconomics lecture**.

There are two entry points:

- **Live demo:** http://127.0.0.1:4320/ — accepts any lecture request and performs the actual retrieval and generation.
- **Stage demo:** http://127.0.0.1:4320/stage — any typed request replays the pinned real run's activity in **40 seconds**, then plays its prepared narration. It makes no live retrieval, model or speech API calls, has no one-hour expiry, and can be replayed repeatedly. Both retain the same keyboard shortcut. The deterministic history includes the completed economics lecture under its actual title; selecting it opens its saved player immediately. There is no visible mode selector or mode label; open the required URL directly. The two entry points retain separate histories and New chat links.

The stage demo reads a private local snapshot rather than choosing the latest run at presentation time. Before presenting, pin a completed real lesson with `npm run demo:prepare -- <run-id>` (omit the ID to select the latest completed lesson), then restart the demo server. This copies its activity, adapted transcript and WAV into ignored `.data/demo-stage/` and checks their hashes at startup. The existing snapshot remains fixed until explicitly prepared again. Keep that directory on the presentation machine; it is not committed to Git. Missing or changed assets produce an explicit blocker and never trigger a live run.

The live demo uses the user's signed-in **Aside CLI**, explicitly selecting **Claude Sonnet 5.5** through its connected Claude subscription. It retrieves the actual Moodle transcript and matching lecture notes/slides, adapts an opening teaching lesson so it can be understood without the visuals, and generates real **ElevenLabs** narration. The page shows live activity, then a player, adapted transcript and source links. Each submission in the live interface starts a fresh run; an existing run link opens its saved result. It does not silently substitute example course content if retrieval fails.

The preparation view shows five clear milestones. Expanding “View detailed activity” reveals every observed operation, its agent, start time, duration and actual result. It polls the full parent and child-task histories while retrieval and adaptation run, then saves the action history locally with the lesson. Parallel operations remain separate, and failed attempts stay marked as failures even if a later attempt succeeds. Only operation metadata is exposed; reasoning, commands and raw tool results are excluded. The website uses task descriptions instead of provider names, with the official Moodle wordmark inline. If detailed activity becomes unavailable, the page reports that rather than inventing progress.

Both versions display a synchronized reader beneath the audio controls. It follows actual word timestamps from the narration, reveals spoken words in black, and keeps the next two lines grey. The text follows the media clock across pauses, seeking and playback speeds; it respects reduced-motion preferences. Completed preparation folds automatically so the player and reader have room. Content scrolls inside an inset viewport and never behind the frame; the bubble and control positions retain the original demo layout. The full transcript remains available. New narration saves its original alignment alongside the WAV; stage preparation requires these timings and includes them in its pinned snapshot. There is no timing based on guessed reading speed.

## Run

```sh
npm ci
export PATH="$PWD/node_modules/node/bin:$PATH"
npm run build:demo
LECTURE_ACCESS_ELEVENLABS_KEY_FILE=/absolute/path/to/private-elevenlabs-key npm run demo
```

Open **http://127.0.0.1:4320**. Aside must be running, Claude must be connected in Aside, and Moodle must be signed in in the user's Aside browser. `DEMO_ASIDE_MODEL` can select another available Claude model; its default is `claude-code/claude-sonnet-5-5`. The default stock ElevenLabs voice is Bella; `LECTURE_ACCESS_ELEVENLABS_VOICE_ID` can override it.

OpenAI keys are not required for this demo. Aside subprocesses receive no API-key environment variables. Provider keys and the retrieved private lecture material remain on the local server, under ignored `.data/demo/`. Do not commit that directory. Only the adapted narration is sent to ElevenLabs.

A generated demo result is an **opening lesson**, not a claim to reproduce an entire two-hour lecture. The player displays that scope. Missing or unreadable source information must be stated instead of guessed.

The prior extension prototype and its separate verification are retained in this repository, but they are not the demo entry point.

## Check the running demo

`npm run test:demo` checks the blank entry screen, keyboard flow, bubble placement and mobile layout without provider calls. `npm run test:demo -- --prepared` additionally plays an existing real prepared lesson and checks its transcript/activity; it does not generate another lesson. Install the task-local browser with `PLAYWRIGHT_BROWSERS_PATH=.cache/playwright npx playwright install chromium` if needed.

`npm run test:demo -- --stage` measures the stage replay against its forty-second timeline, repeats it to check identical steps/results, plays the stored audio and checks that there are no live or external browser requests.

The visual treatment uses self-hosted Instrument Serif, Geist and Geist Mono, the lavender/indigo Prism palette, white and tinted surfaces, gradient artwork and supplied status icons. The product remains **Earshot**, with the same layout, control positions, keyboard bindings and steady trace. The Prism reference contributes styling and artwork only.

During preparation, the five milestone labels and row positions stay fixed. Their indicators advance at verified pipeline boundaries; rapidly changing tool descriptions and action counts are kept inside the detailed activity log.

The microphone beside the request field records up to one minute. Stop recording to transcribe through ElevenLabs Scribe; the words appear in the editable request field for review before submitting. The API key stays on the local server. Microphone denial and transcription failures leave typing available. Voice input makes a real transcription request only when explicitly used, including on the deterministic site.
