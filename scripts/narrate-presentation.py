import base64
import json
import os
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / ".data/presentation"
(out / "narration").mkdir(parents=True, exist_ok=True)
plan = json.loads((root / "presentation/plan.json").read_text())
key = (
    Path(
        os.environ.get(
            "LECTURE_ACCESS_ELEVENLABS_KEY_FILE", "/private/tmp/earshot-elevenlabs-key"
        )
    )
    .read_text()
    .strip()
)


def req(url, payload=None):
    r = urllib.request.Request(
        "https://api.elevenlabs.io" + url,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(r, timeout=180) as f:
        return json.load(f)


voices = req("/v2/voices?category=premade&page_size=100").get("voices", [])
voices = [v for v in voices if v.get("category") == "premade"]
voice = next(
    (
        v
        for name in ["George", "Daniel", "Brian", "Adam"]
        for v in voices
        if v["name"].split(" - ")[0] == name
    ),
    None,
)
if voice is None:
    voice = next(
        (v for v in voices if v.get("labels", {}).get("use_case") == "narration"),
        voices[0],
    )
chunks = [c for c in plan["cues"] if c["start"] != 27]
text = "\n\n".join(c["say"].replace("‘", "'").replace("’", "'") for c in chunks)
print(
    "Generating ElevenLabs narration with stock voice " + voice["name"] + ".",
    flush=True,
)
data = req(
    "/v1/text-to-speech/"
    + voice["voice_id"]
    + "/with-timestamps?output_format=mp3_44100_128",
    {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.55,
            "similarity_boost": 0.75,
            "style": 0.15,
            "use_speaker_boost": True,
        },
    },
)
(out / "narration/narrator.mp3").write_bytes(base64.b64decode(data["audio_base64"]))
alignment = data["alignment"]
spoken = "".join(alignment["characters"])
cursor = 0
segments = []
for cue in chunks:
    s = cue["say"].replace("‘", "'").replace("’", "'")
    at = spoken.find(s, cursor)
    if at < 0:
        raise RuntimeError("Narration alignment did not preserve the cue text.")
    end = at + len(s)
    start = max(0, alignment["character_start_times_seconds"][at] - 0.025)
    stop = alignment["character_end_times_seconds"][end - 1] + 0.09
    segments.append({**cue, "sourceStart": start, "sourceEnd": stop})
    cursor = end
(out / "narration/alignment.json").write_text(json.dumps(alignment))
(out / "narration/segments.json").write_text(
    json.dumps(
        {
            "voice": {"name": voice["name"], "id": voice["voice_id"]},
            "segments": segments,
        },
        indent=2,
    )
)
print("Narration saved; " + str(len(segments)) + " timed segments.", flush=True)
