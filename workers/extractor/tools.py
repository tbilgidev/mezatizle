#!/usr/bin/env python3
"""CLI helpers for ASR/OCR. Falls back to mock when optional deps missing."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def mock_transcribe(recording_id: str, storage_root: str) -> dict:
    # Persist via stdout JSON; TS worker also writes DB for mock path.
    audio = Path(storage_root) / "audio" / f"{recording_id}.wav"
    return {
        "ok": True,
        "backend": "mock",
        "audio_exists": audio.exists(),
        "segments": 4,
        "note": "faster-whisper not installed; mock ASR",
    }


def mock_ocr(recording_id: str, storage_root: str) -> dict:
    frames = Path(storage_root) / "frames" / recording_id
    n = len(list(frames.glob("*.jpg"))) if frames.is_dir() else 0
    return {
        "ok": True,
        "backend": "mock",
        "frames": n,
        "note": "PaddleOCR not installed; mock OCR",
    }


def try_faster_whisper(recording_id: str, storage_root: str) -> dict:
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:  # noqa: BLE001
        out = mock_transcribe(recording_id, storage_root)
        out["pythonError"] = f"faster_whisper unavailable: {exc}"
        return out

    audio = Path(storage_root) / "audio" / f"{recording_id}.wav"
    if not audio.exists():
        return mock_transcribe(recording_id, storage_root)

    model_size = os.environ.get("WHISPER_MODEL", "tiny")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(str(audio), language="tr")
    texts = []
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        import psycopg

        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM transcript_segments WHERE recording_id = %s",
                    (recording_id,),
                )
                for seg in segments:
                    cur.execute(
                        """
                        INSERT INTO transcript_segments
                          (recording_id, start_ms, end_ms, text, confidence, source)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            recording_id,
                            int(seg.start * 1000),
                            int(seg.end * 1000),
                            seg.text.strip(),
                            None,
                            "faster_whisper",
                        ),
                    )
                    texts.append(seg.text.strip())
            conn.commit()
    else:
        texts = [s.text.strip() for s in segments]
    return {"ok": True, "backend": "faster-whisper", "segments": len(texts)}


def try_paddleocr(recording_id: str, storage_root: str) -> dict:
    try:
        from paddleocr import PaddleOCR  # type: ignore
    except Exception as exc:  # noqa: BLE001
        out = mock_ocr(recording_id, storage_root)
        out["pythonError"] = f"paddleocr unavailable: {exc}"
        return out

    frames = Path(storage_root) / "frames" / recording_id
    files = sorted(frames.glob("*.jpg")) if frames.is_dir() else []
    if not files:
        return mock_ocr(recording_id, storage_root)

    ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    hits = 0
    dsn = os.environ.get("DATABASE_URL")
    texts = []
    for fp in files[:30]:
        result = ocr.ocr(str(fp), cls=True)
        for block in result or []:
            for line in block or []:
                if line and len(line) >= 2:
                    texts.append(str(line[1][0]))
                    hits += 1
    if dsn and texts:
        import psycopg

        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                for t in texts[:50]:
                    cur.execute(
                        """
                        INSERT INTO observed_comments
                          (recording_id, body, source, offset_ms)
                        VALUES (%s, %s, %s, %s)
                        """,
                        (recording_id, t, "ocr_frame", 0),
                    )
            conn.commit()
    return {"ok": True, "backend": "paddleocr", "frames": len(files), "texts": hits}


def main() -> None:
    if len(sys.argv) < 4:
        print(json.dumps({"ok": False, "error": "usage: tools.py transcribe|ocr <recordingId> <storageRoot>"}))
        sys.exit(2)
    action, recording_id, storage_root = sys.argv[1], sys.argv[2], sys.argv[3]
    if action == "transcribe":
        print(json.dumps(try_faster_whisper(recording_id, storage_root)))
    elif action == "ocr":
        print(json.dumps(try_paddleocr(recording_id, storage_root)))
    else:
        print(json.dumps({"ok": False, "error": "unknown action"}))
        sys.exit(2)


if __name__ == "__main__":
    main()
