import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / ".data/presentation"
delivery = root.parent / "earshot-video"
meta = json.loads((out / "final-timeline.json").read_text())
meta["appAudio"] = {
    "start": 29.273,
    "end": 34.393,
    "sourceStart": 241.35,
    "duration": 5.12,
    "text": "The horizontal axis is wealth in pounds, and the vertical axis is utility.",
}
meta["visuals"]["lectureGraph"] = [24, 29.3]
(out / "final-timeline.json").write_text(json.dumps(meta, indent=2) + "\n")


def stamp(t):
    ms = round(t * 1000)
    return (
        f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"
    )


subs = [(c["timelineStart"], c["timelineEnd"], c["say"]) for c in meta["segments"]] + [
    (29.354, 32.013, "The horizontal axis is wealth in pounds,"),
    (32.047, 34.30, "and the vertical axis is utility."),
]
subs.sort()
srt = "\n".join(
    f"{i}\n{stamp(a)} --> {stamp(b)}\n{t}\n" for i, (a, b, t) in enumerate(subs, 1)
)
(out / "earshot-captions.srt").write_text(srt)
(delivery / "Earshot-captions.srt").write_text(srt)
# Hold the real source diagram until the direct axis explanation begins.
new = out / "earshot-revised-picture.mp4"
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-i",
        str(out / "earshot-demo-60s.mp4"),
        "-loop",
        "1",
        "-i",
        str(out / "lecture-graph.png"),
        "-i",
        str(out / "earshot-captions.srt"),
        "-filter_complex",
        "[0:v][1:v]overlay=enable='between(t,24,29.3)'[v]",
        "-map",
        "[v]",
        "-map",
        "0:a:0",
        "-map",
        "2:0",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-c:s",
        "mov_text",
        "-metadata:s:s:0",
        "language=eng",
        "-t",
        "60",
        "-movflags",
        "+faststart",
        str(new),
    ],
    check=True,
)
import shutil

shutil.copyfile(new, out / "earshot-demo-60s.mp4")
# Keep supplied documentation and the reusable plan consistent with the new excerpt.
for p in [root / "presentation/plan.json", delivery / "VIDEO_RUNDOWN.md"]:
    s = p.read_text().replace(
        "Now picture this on a graph. The horizontal axis", "The horizontal axis"
    )
    p.write_text(s)
subprocess.run(
    ["python3", str(root / "scripts/repair-presentation-audio.py")], check=True
)
shutil.copyfile(
    delivery / "Earshot-demo-60s-corrected.mp4", delivery / "Earshot-demo-60s-final.mp4"
)
watch = delivery / "watch.html"
watch.write_text(
    watch.read_text().replace(
        "Earshot-demo-60s-corrected.mp4", "Earshot-demo-60s-final.mp4"
    )
)
print("FINAL VIDEO:", delivery / "Earshot-demo-60s-final.mp4")
