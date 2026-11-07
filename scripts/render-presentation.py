import fractions
import json
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / ".data/presentation"
plan = json.loads((root / "presentation/plan.json").read_text())
capture = json.loads((out / "capture.json").read_text())
raw = Path(capture["sourceVideo"])


def run(args):
    with (out / "render.log").open("a") as log:
        subprocess.run(args, check=True, stdout=log, stderr=log)


probe = json.loads(
    subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(raw),
        ]
    )
)
stream = next(s for s in probe["streams"] if s["codec_type"] == "video")
fps = float(fractions.Fraction(stream["r_frame_rate"]))
colors = subprocess.check_output(
    [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(raw),
        "-t",
        "8",
        "-vf",
        "scale=1:1:flags=area",
        "-pix_fmt",
        "rgb24",
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "pipe:1",
    ]
)
slate = [
    i // 3
    for i in range(0, len(colors) - 2, 3)
    if colors[i] > 200 and colors[i + 1] < 50 and colors[i + 2] > 200
]
if not slate:
    raise RuntimeError("Recording synchronization slate was not found.")
trim = (max(slate) + 1) / fps
played = next(e for e in capture["events"] if e["name"] == "sample_played")
audio_at = played["at"] / 1000 - (played["sourceTime"] - capture["sampleStart"])
print(
    f"Rendering clean 60-second video; slate ends at {trim:.3f}s; app audio starts at {audio_at:.3f}s.",
    flush=True,
)
filters = f"[0:v]trim=start={trim}:duration=60,setpts=PTS-STARTPTS,scale=1920:1080:flags=lanczos,fps=30,setsar=1[v];[1:a]asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=6.94:d=0.06,loudnorm=I=-18:TP=-2:LRA=7,adelay={round(audio_at * 1000)}:all=1,apad,atrim=duration=60[a]"
master = out / "earshot-demo-60s.mp4"
run(
    [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(raw),
        "-ss",
        str(capture["sampleStart"]),
        "-t",
        "7",
        "-i",
        str(root / ".data/demo-stage/lesson.wav"),
        "-filter_complex",
        filters,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
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
        "title=Earshot — 60-second demo",
        str(master),
    ]
)


def srt_time(t):
    ms = round(t * 1000)
    return (
        f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"
    )


def ass_time(t):
    cs = round(t * 100)
    return f"{cs // 360000}:{cs // 6000 % 60:02}:{cs // 100 % 60:02}.{cs % 100:02}"


srt = []
ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Cue,Geist,29,&H00FFFFFF,&H00FFFFFF,&HCC4B1F1E,&HCC4B1F1E,0,0,0,0,100,100,0,0,3,10,0,2,110,110,35,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
]
for i, cue in enumerate(plan["cues"], 1):
    voice = (
        cue["say"]
        if cue["start"] != 27
        else "PAUSE — listen to the app. Resume narration at 00:35."
    )
    srt.append(f"{i}\n{srt_time(cue['start'])} --> {srt_time(cue['end'])}\n{voice}\n")
    label = f"{cue['start']:02}–{cue['end']:02}s  |  {cue['label'].upper()}"
    text = "{\\fs21\\c&HFFC4C9&}" + label + "{\\r}\\N" + voice.replace("\n", " ")
    ass.append(
        f"Dialogue: 0,{ass_time(cue['start'])},{ass_time(cue['end'])},Cue,,0,0,0,,{text}"
    )
(out / "narration-cues.srt").write_text("\n".join(srt))
(out / "narration-cues.ass").write_text("\n".join(ass) + "\n")
print("Rendering the rehearsal version with timed narration prompts.", flush=True)
run(
    [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(master),
        "-vf",
        f"ass={out}/narration-cues.ass:fontsdir={out}/assets",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "19",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-t",
        "60",
        "-movflags",
        "+faststart",
        "-metadata",
        "title=Earshot — narration rehearsal",
        str(out / "earshot-rehearsal-60s.mp4"),
    ]
)
(out / "edit-timeline.json").write_text(
    json.dumps(
        {
            "duration": 60,
            "resolution": [1920, 1080],
            "fps": 30,
            "sourceTrimSeconds": trim,
            "appAudio": {
                "timelineStart": audio_at,
                "duration": 7,
                "sourceStart": capture["sampleStart"],
            },
            "cues": plan["cues"],
            "cameraOverlaySuggested": {
                "x": 1480,
                "y": 615,
                "width": 340,
                "height": 380,
            },
        },
        indent=2,
    )
    + "\n"
)
for font in [
    "geist.woff2",
    "geist-mono.woff2",
    "instrument-serif.woff2",
    "geist-OFL.txt",
    "geistmono-OFL.txt",
    "instrumentserif-OFL.txt",
]:
    shutil.copyfile(root / "apps/demo/public/fonts" / font, out / "assets" / font)
print("Video renders complete.", flush=True)
