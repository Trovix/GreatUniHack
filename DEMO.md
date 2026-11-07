# Lecture request demo

Start on a blank white screen with an inset black frame and a speech bubble at the bottom left. Press **Cmd+K** (Mac) or **Ctrl+K**, or click the bubble. It moves to the centre and reveals the request field.

Example: **Teach me the content from my latest microeconomics lecture**.

The demo uses the user's signed-in **Aside CLI**, explicitly selecting **Claude Sonnet 5.5** through its connected Claude subscription. It retrieves the actual Moodle transcript and matching lecture notes/slides, adapts an opening teaching lesson so it can be understood without the visuals, and generates real **ElevenLabs** narration. The page shows live activity, then a player, adapted transcript and source links. Repeating the same request within an hour reuses the real prepared lesson without another provider call; **Refresh from Moodle** explicitly runs it again. It does not silently substitute example course content if retrieval fails.

The activity feed stays visible and reports each observed operation, its agent, start time, duration and actual result. It polls the full parent and child-task histories while retrieval and adaptation run, then saves the action history locally with the lesson. Parallel operations remain separate, and failed attempts stay marked as failures even if a later attempt succeeds. Only operation metadata is exposed; reasoning, commands and raw tool results are excluded. The website uses task descriptions instead of provider names, with the official Moodle wordmark inline. If detailed activity becomes unavailable, the page reports that rather than inventing progress.

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
