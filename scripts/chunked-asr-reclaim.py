#!/usr/bin/env python3
"""Chunked faster-whisper reclaim for long mezats that OOM on full-file ASR."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

RID = os.environ.get("RECORDING_ID", "0845b494-3fb7-4e5c-9219-c772c24a1362")
JOB_ID = os.environ.get("JOB_ID", "4056f277-c5ef-4bda-9c83-577b2191e716")
STORAGE = Path(os.environ.get("STORAGE_ROOT", "/home/tolga/projects/mezatizle/storage"))
DSN = os.environ.get(
    "DATABASE_URL", "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle"
)
MODEL = os.environ.get("WHISPER_MODEL", "tiny")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
CHUNK_SEC = int(os.environ.get("ASR_CHUNK_SEC", "600"))
LOG = Path(os.environ.get("ASR_CHUNK_LOG", "/home/tolga/projects/mezatizle/logs/glam-chunked-asr.log"))


def log(msg: str) -> None:
    line = msg.rstrip()
    print(line, flush=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def main() -> int:
    from faster_whisper import WhisperModel
    import psycopg

    audio = STORAGE / "audio" / f"{RID}.wav"
    if not audio.exists():
        log(f"FAIL audio missing {audio}")
        return 1

    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COALESCE(duration_seconds, 0) FROM recordings WHERE id = %s",
                (RID,),
            )
            row = cur.fetchone()
            dur = float(row[0] or 0)
            cur.execute("DELETE FROM transcript_segments WHERE recording_id = %s", (RID,))
            conn.commit()

    if dur <= 0:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(audio),
            ],
            text=True,
        ).strip()
        dur = float(out)

    log(f"start rid={RID[:8]} dur_s={dur:.1f} model={MODEL} chunk={CHUNK_SEC}s")
    model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE)

    total_segs = 0
    n_chunks = max(1, int(dur // CHUNK_SEC) + (1 if dur % CHUNK_SEC > 1 else 0))

    with tempfile.TemporaryDirectory(prefix="mezat-asr-") as tmp:
        tmp_p = Path(tmp)
        for i in range(n_chunks):
            start = i * CHUNK_SEC
            if start >= dur:
                break
            length = min(CHUNK_SEC, dur - start)
            chunk = tmp_p / f"chunk_{i:04d}.wav"
            subprocess.check_call(
                [
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-ss", str(start), "-t", str(length), "-i", str(audio),
                    "-ac", "1", "-ar", "16000", str(chunk),
                ]
            )
            segs_iter, _info = model.transcribe(
                str(chunk),
                language="tr",
                vad_filter=False,
                beam_size=1,
                condition_on_previous_text=False,
            )
            batch = 0
            with psycopg.connect(DSN) as conn:
                with conn.cursor() as cur:
                    for seg in segs_iter:
                        text = (seg.text or "").strip()
                        if not text:
                            continue
                        conf = None
                        if getattr(seg, "avg_logprob", None) is not None:
                            conf = max(0.0, min(1.0, 1.0 + float(seg.avg_logprob) / 5.0))
                        cur.execute(
                            """
                            INSERT INTO transcript_segments
                              (recording_id, start_ms, end_ms, text, confidence, source)
                            VALUES (%s, %s, %s, %s, %s, %s)
                            """,
                            (
                                RID,
                                int((start + seg.start) * 1000),
                                int((start + seg.end) * 1000),
                                text,
                                conf,
                                "faster_whisper_chunked",
                            ),
                        )
                        total_segs += 1
                        batch += 1
                    cover_pct = min(99.0, (start + length) / dur * 100.0)
                    job_pct = int(min(95, max(30, 30 + cover_pct * 0.65)))
                    ui_note = f"asr_chunked {i+1}/{n_chunks}"
                    cur.execute(
                        """
                        UPDATE processing_jobs
                        SET updated_at = now(), locked_at = now(),
                            stage = %s, progress_percent = %s
                        WHERE id = %s::uuid AND status = 'running'
                        """,
                        (ui_note, job_pct, JOB_ID),
                    )
                    cur.execute(
                        """
                        UPDATE recordings SET status = 'transcribing', updated_at = now()
                        WHERE id = %s::uuid
                          AND status NOT IN ('complete', 'analyzing', 'failed', 'cancelled')
                        """,
                        (RID,),
                    )
                    conn.commit()
            log(
                f"chunk {i+1}/{n_chunks} start={start:.0f}s len={length:.0f}s "
                f"+{batch} segs total={total_segs} job_pct={job_pct}"
            )
            try:
                chunk.unlink()
            except OSError:
                pass

    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE processing_jobs
                SET status = 'succeeded', progress_percent = 100, stage = 'done',
                    finished_at = now(), locked_by = NULL, locked_at = NULL,
                    result_json = jsonb_build_object(
                      'chunked', true,
                      'segments', %s::integer,
                      'model', %s::text,
                      'chunk_sec', %s::integer
                    ),
                    error_message = 'chunked ASR complete (tiny slices)',
                    updated_at = now()
                WHERE id = %s::uuid
                """,
                (int(total_segs), str(MODEL), int(CHUNK_SEC), JOB_ID),
            )
            conn.commit()
    log(f"DONE segs={total_segs}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        log(f"ERROR {exc!r}")
        raise
