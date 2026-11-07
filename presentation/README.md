# Earshot presentation

The finished, 60-second video and its captions, story, narration, rundown, and player are saved in `video/`. Open `video/watch.html` or play `video/Earshot-demo-60s.mp4` directly. The video is the approved final export; later app changes do not alter it. Its SHA-256 is recorded in `video/VALIDATION.json`.

`PROJECT_STORY.md` contains the project description. `plan.json` records the narration and screen sequence.

## Production scripts

The scripts preserve the workflow used to create the video. They require local source assets under `.data/presentation/`, the selected lecture under `.data/demo-stage/`, FFmpeg/FFprobe, and Python dependencies listed in `requirements.txt`. The private source recordings, complete lecture, extracted deck, API responses, and credentials are not checked in.

- `scripts/record-presentation.mjs` records the local app with Playwright. Start the app at port 4320 first.
- `scripts/render-presentation.py` trims the raw recording and renders the screen master and rehearsal cues.
- `scripts/narrate-presentation.py` generates ElevenLabs narration and alignment. This is the only production step that makes a paid API request. Supply a private key file through `LECTURE_ACCESS_ELEVENLABS_KEY_FILE`.
- `scripts/finish-presentation.py` combines the app footage, deck artwork and narration.
- `scripts/repair-presentation-audio.py` constructs a continuous PCM timeline and checks decoded AAC against the intended mix.
- `scripts/revise-presentation-excerpt.py` applies the final approved excerpt: the direct explanation of the graph axes, with matching captions and a longer graph cutaway. Run this after the finishing step for the final cut.

These are explicit production commands, not part of the app build. Do not rerun them to update the app. Local work and generated intermediate files remain under `.data/`; the deliverable in `video/` is a separate, unchanged copy.
