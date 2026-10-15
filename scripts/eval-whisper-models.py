#!/usr/bin/env python3
"""Compare faster-whisper base vs small on fixture audio (LOCAL, no paid API).

Usage (from repo root, with .venv):
  .venv/bin/python scripts/eval-whisper-models.py

Extracts audio from fixtures/sample-live.mp4 if needed, runs both models,
scores presence of key Turkish sale phrases, prints JSON recommendation.
Does NOT change WHISPER_MODEL — document outcome in analysis-pipeline.md.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixtures" / "sample-live.mp4"
AUDIO = ROOT / "fixtures" / "sample-live.wav"
PHRASES = [
    "satıldı",
    "satildi",
    "açılış",
    "acilis",
    "sıradaki",
    "siradaki",
    "tl",
    "700",
    "450",
    "500",
]


def ensure_wav() -> Path:
    if AUDIO.exists() and AUDIO.stat().st_size > 1000:
        return AUDIO
    if not FIXTURE.exists():
        print(json.dumps({"ok": False, "error": f"missing {FIXTURE}"}))
        sys.exit(1)
    subprocess.check_call(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(FIXTURE),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(AUDIO),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return AUDIO


def run_model(size: str, wav: Path) -> dict:
    from faster_whisper import WhisperModel

    t0 = time.time()
    model = WhisperModel(size, device="cpu", compute_type=os.environ.get("WHISPER_COMPUTE", "int8"))
    segs, info = model.transcribe(str(wav), language="tr", vad_filter=True, beam_size=1)
    texts = []
    for s in segs:
        t = (s.text or "").strip()
        if t:
            texts.append(t)
    wall = time.time() - t0
    joined = " ".join(texts).lower()
    hits = {p: (p in joined) for p in PHRASES}
    score = sum(1 for v in hits.values() if v)
    return {
        "model": size,
        "wallSec": round(wall, 2),
        "segments": len(texts),
        "phraseHits": hits,
        "phraseScore": score,
        "phraseMax": len(PHRASES),
        "sample": texts[:4],
        "language": getattr(info, "language", "tr"),
    }


def main() -> None:
    wav = ensure_wav()
    results = []
    for size in ("base", "small"):
        try:
            results.append(run_model(size, wav))
        except Exception as exc:  # noqa: BLE001
            results.append({"model": size, "error": str(exc)})

    usable = [r for r in results if "phraseScore" in r]
    recommendation = "base"
    rationale = "Keep base: lower CPU; small only if phraseScore gain ≥2 on fixture."
    if len(usable) == 2:
        base, small = usable[0], usable[1]
        gain = small["phraseScore"] - base["phraseScore"]
        cpu_ratio = (small["wallSec"] / base["wallSec"]) if base["wallSec"] else None
        if gain >= 2 and (cpu_ratio is None or cpu_ratio < 3.5):
            recommendation = "small"
            rationale = (
                f"small gains +{gain} phrase hits at ~{cpu_ratio:.1f}× CPU — worth it on this fixture."
            )
        else:
            rationale = (
                f"base phraseScore={base['phraseScore']}, small={small['phraseScore']} "
                f"(gain {gain}), CPU ratio ~{cpu_ratio}; keep base default."
            )

    out = {
        "ok": True,
        "audio": str(wav),
        "results": results,
        "recommendation": recommendation,
        "rationale": rationale,
        "note": "Does not mutate env; set WHISPER_MODEL only after operator review.",
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    out_path = ROOT / "fixtures" / "whisper-base-vs-small.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
