#!/usr/bin/env python3
"""Build a short synthetic Turkish auction MP4 for local pipeline smoke tests."""
from __future__ import annotations

import asyncio
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "fixtures" / "sample-live.mp4"
DURATION = int(__import__("os").environ.get("SYNTH_DURATION_SEC", "90"))

LINES = [
    (0, "Sıradaki ürün: lacivert ceket, açılış 500 TL"),
    (12, "Ayşe diyor ki 600"),
    (24, "Mehmet 700 TL verdi"),
    (40, "Satıldı Mehmet 700 TL"),
    (55, "Yeni ürün: kırmızı çanta, açılış 300 TL"),
    (70, "Satıldı Ayşe 450 TL"),
]

COMMENTS = [
    "@ayse_demo 600",
    "@mehmet_demo 700",
    "satıldı 700 TL",
    "@ayse_demo 450",
]


async def synth_voice(path: Path) -> None:
    import edge_tts

    script = ". ".join(t for _, t in LINES) + "."
    # Turkish female neural voice
    communicate = edge_tts.Communicate(script, voice="tr-TR-EmelNeural")
    await communicate.save(str(path))


def burn_video(audio: Path, out: Path) -> None:
    # Pad/trim voice to exact DURATION so video is not cut short by -shortest
    padded = audio.with_suffix(".pad.wav")
    subprocess.check_call(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(audio),
            "-af",
            f"apad=whole_dur={DURATION}",
            "-t",
            str(DURATION),
            "-ar",
            "16000",
            "-ac",
            "1",
            str(padded),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Build drawtext filters cycling comment lines on the right
    filters = []
    # Dark right panel for "comments"
    filters.append(
        "drawbox=x=iw*0.55:y=ih*0.35:w=iw*0.42:h=ih*0.55:color=black@0.55:t=fill"
    )
    for i, c in enumerate(COMMENTS):
        y = f"h*0.40+{i}*28"
        safe = c.replace(":", "\\:").replace("'", "")
        filters.append(
            f"drawtext=text='{safe}':x=w*0.58:y={y}:fontsize=22:fontcolor=white"
        )
    for t0, text in LINES:
        safe = text.replace(":", "\\:").replace("'", "")
        enable = f"between(t\\,{t0}\\,{t0 + 8})"
        filters.append(
            f"drawtext=text='{safe}':x=40:y=h-80:fontsize=20:fontcolor=yellow:enable='{enable}'"
        )
    vf = ",".join(filters)
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"color=c=0x1a2744:s=720x1280:d={DURATION}:r=20",
        "-i",
        str(padded),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-c:a",
        "aac",
        "-b:a",
        "80k",
        "-ac",
        "1",
        "-t",
        str(DURATION),
        "-movflags",
        "+faststart",
        str(out),
    ]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        audio = Path(td) / "voice.mp3"
        asyncio.run(synth_voice(audio))
        # Pad/trim audio to DURATION via ffmpeg in burn step (-shortest)
        burn_video(audio, OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, ~{DURATION}s)")


if __name__ == "__main__":
    main()
