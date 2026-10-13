#!/usr/bin/env python3
"""Optional Python poller for extract/ASR/OCR jobs (Postgres SKIP LOCKED)."""
from __future__ import annotations

import os
import time
import subprocess
import json
from pathlib import Path

try:
    import psycopg
except ImportError:
    print("psycopg required: pip install -r requirements.txt")
    raise


DSN = os.environ.get(
    "DATABASE_URL", "postgres://mezatizle:mezatizle@127.0.0.1:5432/mezatizle"
)
STORAGE = os.environ.get("STORAGE_ROOT", "./storage")
WORKER_ID = os.environ.get("WORKER_ID", "py-extractor-1")
POLL = float(os.environ.get("WORKER_POLL_INTERVAL_MS", "2000")) / 1000.0
TYPES = ("extract_audio_frames", "transcribe", "ocr_frames")


def claim(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH next_job AS (
              SELECT id FROM processing_jobs
              WHERE status = 'queued' AND available_at <= now()
                AND job_type = ANY(%s)
              ORDER BY priority ASC, created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
            )
            UPDATE processing_jobs j
            SET status = 'running', locked_by = %s, locked_at = now(),
                started_at = COALESCE(started_at, now()), attempts = attempts + 1,
                updated_at = now()
            FROM next_job
            WHERE j.id = next_job.id
            RETURNING j.id, j.recording_id, j.job_type
            """,
            (list(TYPES), WORKER_ID),
        )
        row = cur.fetchone()
    conn.commit()
    return row


def complete(conn, job_id, result):
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE processing_jobs
            SET status = 'succeeded', progress_percent = 100, stage = 'done',
                finished_at = now(), result_json = %s::jsonb, locked_by = NULL,
                updated_at = now()
            WHERE id = %s
            """,
            (json.dumps(result), job_id),
        )
    conn.commit()


def fail(conn, job_id, msg):
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE processing_jobs
            SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
                error_message = %s,
                available_at = CASE WHEN attempts >= max_attempts THEN available_at
                                    ELSE now() + interval '15 seconds' END,
                locked_by = NULL, locked_at = NULL, updated_at = now()
            WHERE id = %s
            """,
            (msg, job_id),
        )
    conn.commit()


def run_ffmpeg_extract(recording_id: str) -> dict:
    import glob

    root = Path(STORAGE)
    inp = root / "recordings" / f"{recording_id}.mp4"
    audio = root / "audio" / f"{recording_id}.wav"
    frames = root / "frames" / recording_id
    frames.mkdir(parents=True, exist_ok=True)
    audio.parent.mkdir(parents=True, exist_ok=True)
    subprocess.check_call(
        [
            "ffmpeg", "-y", "-i", str(inp), "-vn", "-acodec", "pcm_s16le",
            "-ar", "16000", "-ac", "1", str(audio),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    interval = os.environ.get("FRAME_INTERVAL_SECONDS", "5")
    subprocess.check_call(
        [
            "ffmpeg", "-y", "-i", str(inp),
            "-vf", f"fps=1/{interval}", "-q:v", "3",
            str(frames / "frame_%05d.jpg"),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return {"frameCount": len(glob.glob(str(frames / "*.jpg"))), "backend": "ffmpeg"}


def main():
    print(f"[py-worker] {WORKER_ID} storage={STORAGE}")
    while True:
        with psycopg.connect(DSN) as conn:
            job = claim(conn)
            if not job:
                time.sleep(POLL)
                continue
            job_id, recording_id, job_type = job
            try:
                if job_type == "extract_audio_frames":
                    result = run_ffmpeg_extract(recording_id)
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE recordings SET status='extracted', updated_at=now() WHERE id=%s",
                            (recording_id,),
                        )
                    conn.commit()
                elif job_type == "transcribe":
                    out = subprocess.check_output(
                        ["python3", "tools.py", "transcribe", recording_id, STORAGE],
                        text=True,
                    )
                    result = json.loads(out)
                elif job_type == "ocr_frames":
                    out = subprocess.check_output(
                        ["python3", "tools.py", "ocr", recording_id, STORAGE],
                        text=True,
                    )
                    result = json.loads(out)
                else:
                    raise RuntimeError(f"unsupported {job_type}")
                complete(conn, job_id, result)
            except Exception as exc:  # noqa: BLE001
                fail(conn, job_id, str(exc))


if __name__ == "__main__":
    main()
