import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parents[1]
out = root / ".data/presentation"
voice = out / "narration"


def run(args):
    with (out / "final-render.log").open("a") as log:
        subprocess.run(args, check=True, stdout=log, stderr=log)


def dur(path):
    return float(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(path),
            ]
        )
    )


meta = json.loads((voice / "segments.json").read_text())
segments = meta["segments"]
for i, c in enumerate(segments):
    length = c["sourceEnd"] - c["sourceStart"]
    available = c["end"] - c["start"] - 0.35
    speed = max(1.0, length / available)
    c["speed"] = speed
    c["timelineStart"] = c["start"] + 0.10
    c["timelineEnd"] = c["timelineStart"] + length / speed
    run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-ss",
            str(c["sourceStart"]),
            "-t",
            str(length),
            "-i",
            str(voice / "narrator.mp3"),
            "-af",
            f"atempo={speed},afade=t=in:d=0.012,afade=t=out:st={max(0, length / speed - 0.045)}:d=0.045,loudnorm=I=-17:TP=-2:LRA=7",
            "-ar",
            "48000",
            str(voice / f"cue-{i:02}.wav"),
        ]
    )
    print(
        f"Cue {i + 1}: {length:.2f}s, speed {speed:.3f}, window {c['timelineStart']:.2f}–{c['timelineEnd']:.2f}",
        flush=True,
    )
# Crop the lecture graph directly from the supplied deck. No diagram content is redrawn.
graph = (
    Image.open(out / "deck/slide-06.png").crop((1040, 278, 1697, 664)).convert("RGB")
)
canvas = Image.new("RGB", (1920, 1080), (245, 244, 255))
graph = graph.resize((1478, 869), Image.Resampling.LANCZOS)
canvas.paste(graph, (221, 105))
canvas.save(out / "lecture-graph.png")
# Keep the un-narrated original to make later edits reversible.
base = out / "earshot-screen-master-60s.mp4"
if not base.exists():
    shutil.copyfile(out / "earshot-demo-60s.mp4", base)
args = [
    "ffmpeg",
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    str(base),
    "-loop",
    "1",
    "-i",
    str(out / "deck/slide-01.png"),
    "-loop",
    "1",
    "-i",
    str(out / "lecture-graph.png"),
]
for i in range(len(segments)):
    args += ["-i", str(voice / f"cue-{i:02}.wav")]
fc = [
    "[1:v]scale=1920:1080,format=yuv420p[cover]",
    "[0:v][cover]overlay=enable='lt(t,2.8)+gte(t,56)'[branded]",
    "[branded][2:v]overlay=enable='between(t,24.0,26.75)',fps=30,format=yuv420p[video]",
    "[0:a]volume=1.0[app]",
]
for i, c in enumerate(segments):
    fc.append(f"[{i + 3}:a]adelay={round(c['timelineStart'] * 1000)}:all=1[voice{i}]")
fc.append(
    "[app]"
    + "".join(f"[voice{i}]" for i in range(len(segments)))
    + f"amix=inputs={len(segments) + 1}:normalize=0,alimiter=limit=0.95,apad,atrim=duration=60[audio]"
)
args += [
    "-filter_complex",
    ";".join(fc),
    "-map",
    "[video]",
    "-map",
    "[audio]",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-t",
    "60",
    "-movflags",
    "+faststart",
    "-metadata",
    "title=Earshot — audio-first lectures",
    str(out / "earshot-final-60s.mp4"),
]
print("Rendering final narrated 1080p video.", flush=True)
run(args)


def stamp(t):
    ms = round(t * 1000)
    return (
        f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"
    )


subs = [(c["timelineStart"], c["timelineEnd"], c["say"]) for c in segments]
subs += [
    (27.423, 29.10, "Now picture this on a graph."),
    (29.10, 32.05, "The horizontal axis is wealth in pounds,"),
    (32.05, 34.423, "and the vertical axis is utility."),
]
subs.sort()
srt = "\n".join(
    f"{i}\n{stamp(a)} --> {stamp(b)}\n{t}\n" for i, (a, b, t) in enumerate(subs, 1)
)
(out / "earshot-captions.srt").write_text(srt)
# Embed selectable captions without covering the app's own word-synchronized reader.
run(
    [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(out / "earshot-final-60s.mp4"),
        "-i",
        str(out / "earshot-captions.srt"),
        "-map",
        "0:v",
        "-map",
        "0:a",
        "-map",
        "1:0",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-c:s",
        "mov_text",
        "-metadata:s:s:0",
        "language=eng",
        "-metadata:s:s:0",
        "title=English",
        "-t",
        "60",
        "-movflags",
        "+faststart",
        str(out / "earshot-demo-60s.mp4"),
    ]
)
(out / "final-timeline.json").write_text(
    json.dumps(
        {
            "duration": 60,
            "narrator": meta["voice"],
            "segments": segments,
            "appAudio": {"start": 27.423, "end": 34.423},
            "visuals": {
                "openingDeck": [0, 2.8],
                "lectureGraph": [24, 26.75],
                "closingDeck": [56, 60],
            },
            "captions": "English selectable track",
        },
        indent=2,
    )
)
# Build a continuous PCM mix and verify decoded samples before delivering.
subprocess.run(
    ["python3", str(root / "scripts/repair-presentation-audio.py")], check=True
)
print("Finished: " + str(out / "earshot-demo-60s.mp4"), flush=True)
