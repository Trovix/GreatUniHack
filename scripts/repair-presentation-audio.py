import hashlib
import json
import shutil
import subprocess
import wave
import zipfile
from pathlib import Path

import numpy as np

root = Path(__file__).resolve().parents[1]
out = root / ".data/presentation"
delivery = root.parent / "earshot-video"
rate = 48000
total = 60 * rate
meta = json.loads((out / "final-timeline.json").read_text())


def pcm(path, start=None, duration=None, filters=None):
    args = ["ffmpeg", "-v", "error"]
    if start is not None:
        args += ["-ss", str(start)]
    args += ["-i", str(path)]
    if duration is not None:
        args += ["-t", str(duration)]
    if filters:
        args += ["-af", filters]
    args += ["-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "pipe:1"]
    return np.frombuffer(subprocess.check_output(args), dtype="<f4").copy()


narration = np.zeros(total, dtype=np.float32)
lecture = np.zeros(total, dtype=np.float32)
for i, c in enumerate(meta["segments"]):
    a = pcm(out / f"narration/cue-{i:02}.wav")
    start = round(c["timelineStart"] * rate)
    n = min(len(a), total - start)
    narration[start : start + n] += a[:n]
sample_start = meta["appAudio"].get("sourceStart", 239.5)
sample_duration = meta["appAudio"].get("duration", 7)
sample_samples = round(sample_duration * rate)
a = pcm(
    root / ".data/demo-stage/lesson.wav",
    sample_start,
    sample_duration,
    f"loudnorm=I=-18:TP=-2:LRA=7,afade=t=in:d=0.03,afade=t=out:st={sample_duration - 0.06}:d=0.06",
)
start = round(meta["appAudio"]["start"] * rate)
n = min(len(a), sample_samples, total - start)
lecture[start : start + n] = a[:n]
assert np.count_nonzero(lecture[:start]) == 0
assert np.count_nonzero(lecture[start + sample_samples :]) == 0
assert np.count_nonzero(narration[round(27 * rate) : round(35 * rate)]) == 0
mix = narration + lecture
peak = float(np.max(np.abs(mix)))
if peak > 0.84:
    mix *= 0.84 / peak
wav = out / "earshot-final-mix.wav"
with wave.open(str(wav), "wb") as f:
    f.setnchannels(1)
    f.setsampwidth(2)
    f.setframerate(rate)
    f.writeframes((np.clip(mix, -1, 1) * 32767).astype("<i2").tobytes())
# Copy the already-reviewed picture and captions, replacing every previous audio stream.
fixed = out / "earshot-demo-60s-fixed.mp4"
subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(out / "earshot-demo-60s.mp4"),
        "-i",
        str(wav),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map",
        "0:s:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-c:s",
        "copy",
        "-t",
        "60",
        "-movflags",
        "+faststart",
        "-metadata:s:a:0",
        "title=Earshot narration and timed lecture excerpt",
        str(fixed),
    ],
    check=True,
)
decoded = pcm(fixed)
assert abs(len(decoded) - total) <= 1024
# Check decoded AAC against the actual expected mix throughout the file.
max_errors = []
for t in [
    0,
    1,
    4,
    6,
    10,
    16,
    23,
    24,
    26,
    27,
    28,
    30,
    34,
    35,
    40,
    42,
    49,
    50,
    55,
    56,
    59,
]:
    a = decoded[t * rate : (t + 1) * rate]
    b = mix[t * rate : (t + 1) * rate]
    err = float(np.sqrt(np.mean((a - b) ** 2)))
    max_errors.append(err)
    if t in [4, 16, 23, 40, 49, 55, 59]:
        assert float(np.sqrt(np.mean(a * a))) < 0.002, (
            t,
            "Unexpected audio in silent gap",
        )
    assert err < 0.015, (t, "Encoded mix differs from intended mix", err)
subprocess.run(
    ["ffmpeg", "-v", "error", "-i", str(fixed), "-f", "null", "-"], check=True
)
shutil.copyfile(fixed, delivery / "Earshot-demo-60s.mp4")
shutil.copyfile(fixed, delivery / "Earshot-demo-60s-corrected.mp4")
shutil.copyfile(fixed, out / "earshot-demo-60s.mp4")
validation = {
    "duration": 60,
    "resolution": [1920, 1080],
    "fps": 30,
    "fullDecode": "passed",
    "audioMix": "Rebuilt as a continuous 60-second PCM timeline before AAC encoding",
    "audioStreams": 1,
    "narrator": "ElevenLabs George",
    "lectureAudioSeconds": [meta["appAudio"]["start"], meta["appAudio"]["end"]],
    "lectureStemOutsideWindow": "Exact digital silence",
    "narratorDuringLecture": "Exact digital silence",
    "decodedAACComparedWithExpectedMix": "Passed across opening, transitions, excerpt and ending",
    "maxCheckedRmsError": max(max_errors),
    "sha256": hashlib.sha256(fixed.read_bytes()).hexdigest(),
}
(delivery / "VALIDATION.json").write_text(json.dumps(validation, indent=2) + "\n")
watch = delivery / "watch.html"
s = (
    watch.read_text()
    .replace('src="Earshot-demo-60s-corrected.mp4"', 'src="Earshot-demo-60s.mp4"')
    .replace('src="Earshot-demo-60s-final.mp4"', 'src="Earshot-demo-60s.mp4"')
)
watch.write_text(s)
with zipfile.ZipFile(
    root.parent / "Earshot-video-kit.zip", "w", zipfile.ZIP_DEFLATED
) as z:
    for p in sorted(delivery.iterdir()):
        if p.name not in [
            "Earshot-demo-60s-corrected.mp4",
            "Earshot-demo-60s-final.mp4",
        ]:
            z.write(p, "Earshot-video-kit/" + p.name)
print(json.dumps(validation, indent=2))
print("CORRECTED VIDEO: " + str(delivery / "Earshot-demo-60s-corrected.mp4"))
