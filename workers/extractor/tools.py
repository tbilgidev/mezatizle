#!/usr/bin/env python3
"""Local ASR (faster-whisper) + OCR (PaddleOCR / Tesseract) helpers for mezatizle."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# Comment overlay region as fractions of frame (left, top, right, bottom).
# Instagram live comments usually sit on the right/lower third.
DEFAULT_CROP = os.environ.get("OCR_CROP_FRAC", "0.55,0.40,0.98,0.90")


def _parse_crop(raw: str) -> tuple[float, float, float, float]:
    parts = [float(x.strip()) for x in raw.split(",")]
    if len(parts) != 4:
        return (0.45, 0.35, 0.98, 0.95)
    return (parts[0], parts[1], parts[2], parts[3])


def _norm_text(s: str) -> str:
    t = re.sub(r"\s+", " ", (s or "").strip().lower())
    t = t.replace("ı", "i").replace("ğ", "g").replace("ü", "u")
    t = t.replace("ş", "s").replace("ö", "o").replace("ç", "c")
    return t


def _near_dup(a: str, b: str) -> bool:
    """Fuzzy dedupe: exact, containment, or high char-overlap (prefer miss over spam)."""
    if not a or not b:
        return False
    if a == b:
        return True
    if a in b or b in a:
        return abs(len(a) - len(b)) <= max(4, int(0.35 * max(len(a), len(b))))
    # cheap token Jaccard
    ta, tb = set(a.split()), set(b.split())
    if not ta or not tb:
        return False
    inter = len(ta & tb)
    union = len(ta | tb)
    return union > 0 and inter / union >= 0.85


def _crop_signature(fp: Path, crop_frac: tuple[float, float, float, float]) -> bytes:
    """Tiny grayscale thumbnail of comment crop — detect region change cheaply."""
    from PIL import Image

    img = Image.open(fp).convert("L")
    cropped = _crop_image(img, crop_frac)
    thumb = cropped.resize((48, 32), Image.Resampling.BILINEAR)
    return thumb.tobytes()


def _sig_changed(a: bytes, b: bytes, threshold: float = 0.08) -> bool:
    if not a or not b or len(a) != len(b):
        return True
    diff = sum(1 for x, y in zip(a, b) if abs(x - y) > 18)
    return (diff / len(a)) >= threshold


def _frame_offset_ms(name: str, fps: float) -> int:
    """frame_00001.jpg → offset from 1-based index and OCR fps."""
    m = re.search(r"(\d+)", Path(name).stem)
    if not m:
        return 0
    idx = int(m.group(1))
    if fps <= 0:
        fps = 1.0
    return int(max(0, (idx - 1) / fps) * 1000)


def _fail(msg: str) -> dict:
    return {"ok": False, "error": msg}


def try_faster_whisper(recording_id: str, storage_root: str) -> dict:
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return _fail(f"faster_whisper unavailable: {exc}")

    audio = Path(storage_root) / "audio" / f"{recording_id}.wav"
    if not audio.exists():
        return _fail(f"audio missing: {audio}")

    model_size = os.environ.get("WHISPER_MODEL", "base")
    compute = os.environ.get("WHISPER_COMPUTE", "int8")
    model = WhisperModel(model_size, device="cpu", compute_type=compute)
    segments_iter, info = model.transcribe(
        str(audio),
        language="tr",
        vad_filter=True,
        beam_size=int(os.environ.get("WHISPER_BEAM", "1")),
    )

    dsn = os.environ.get("DATABASE_URL")
    texts: list[str] = []
    rows = 0
    if not dsn:
        for seg in segments_iter:
            texts.append(seg.text.strip())
        return {
            "ok": True,
            "backend": "faster-whisper",
            "model": model_size,
            "language": getattr(info, "language", "tr"),
            "segments": len(texts),
            "note": "no DATABASE_URL; segments not persisted",
        }

    import psycopg

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM transcript_segments WHERE recording_id = %s",
                (recording_id,),
            )
            for seg in segments_iter:
                text = (seg.text or "").strip()
                if not text:
                    continue
                conf = None
                if hasattr(seg, "avg_logprob") and seg.avg_logprob is not None:
                    # map logprob roughly into 0..1 for metrics
                    conf = max(0.0, min(1.0, 1.0 + float(seg.avg_logprob) / 5.0))
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
                        text,
                        conf,
                        "faster_whisper",
                    ),
                )
                texts.append(text)
                rows += 1
            cur.execute(
                """
                UPDATE recordings SET status = 'transcribing', updated_at = now()
                WHERE id = %s
                """,
                (recording_id,),
            )
        conn.commit()

    return {
        "ok": True,
        "backend": "faster-whisper",
        "model": model_size,
        "language": getattr(info, "language", "tr"),
        "segments": rows,
    }


def _crop_image(img, crop_frac: tuple[float, float, float, float]):
    w, h = img.size
    l, t, r, b = crop_frac
    box = (
        int(w * l),
        int(h * t),
        int(w * r),
        int(h * b),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        return img
    return img.crop(box)


def _ocr_paddle(files: list[Path], crop_frac) -> list[tuple[str, str, float]]:
    """Return list of (filename, text, conf)."""
    from paddleocr import PaddleOCR  # type: ignore
    from PIL import Image

    # lang=en covers latin usernames + numbers; Turkish letters often still readable.
    # Use chinese_cht / latin variants only if available — keep en for IG overlays.
    ocr = PaddleOCR(
        use_angle_cls=True,
        lang=os.environ.get("PADDLE_LANG", "en"),
        show_log=False,
        use_gpu=False,
    )
    out: list[tuple[str, str, float]] = []
    for fp in files:
        img = Image.open(fp).convert("RGB")
        cropped = _crop_image(img, crop_frac)
        tmp = fp.parent / f".ocr_{fp.name}"
        cropped.save(tmp, quality=90)
        try:
            result = ocr.ocr(str(tmp), cls=True)
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass
        for block in result or []:
            for line in block or []:
                if not line or len(line) < 2:
                    continue
                text = str(line[1][0]).strip()
                conf = float(line[1][1]) if len(line[1]) > 1 else 0.0
                if text:
                    out.append((fp.name, text, conf))
    return out


def _ocr_tesseract(files: list[Path], crop_frac) -> list[tuple[str, str, float]]:
    import subprocess
    import tempfile
    from PIL import Image, ImageOps

    lang = os.environ.get("TESSERACT_LANG", "eng")  # eng faster; usernames/prices ASCII-heavy
    config = os.environ.get("TESSERACT_CONFIG", "--psm 6 --oem 1")
    timeout_s = float(os.environ.get("OCR_FRAME_TIMEOUT_S", "8"))
    out: list[tuple[str, str, float]] = []
    for fp in files:
        img = Image.open(fp).convert("L")
        cropped = _crop_image(img, crop_frac)
        max_w = int(os.environ.get("OCR_MAX_WIDTH", "360"))
        max_h = int(os.environ.get("OCR_MAX_HEIGHT", "480"))
        if cropped.width > max_w or cropped.height > max_h:
            ratio = min(max_w / cropped.width, max_h / cropped.height)
            cropped = cropped.resize(
                (max(1, int(cropped.width * ratio)), max(1, int(cropped.height * ratio))),
                Image.Resampling.BILINEAR,
            )
        cropped = ImageOps.autocontrast(cropped)
        with tempfile.TemporaryDirectory() as td:
            png = Path(td) / "f.png"
            base = Path(td) / "out"
            cropped.save(png)
            try:
                subprocess.run(
                    [
                        "tesseract",
                        str(png),
                        str(base),
                        "-l",
                        lang,
                        *config.split(),
                    ],
                    check=True,
                    timeout=timeout_s,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
                continue
            txt_path = Path(str(base) + ".txt")
            if not txt_path.exists():
                continue
            text = txt_path.read_text(encoding="utf-8", errors="ignore")
        for line in (text or "").splitlines():
            line = line.strip()
            if len(line) >= 2:
                out.append((fp.name, line, 0.6))
    return out


def _select_ocr_frames(
    all_files: list[Path], crop_frac: tuple[float, float, float, float]
) -> list[Path]:
    """Keep frame budget; OCR denser only when comment-region crop changes.

    Walk every Nth frame for signatures; when the crop changes vs last kept
    frame, include it. Always keep first/last. Cap at OCR_MAX_FRAMES.
    """
    if not all_files:
        return []
    stride = max(1, int(os.environ.get("OCR_FRAME_STRIDE", "2")))
    max_frames = int(os.environ.get("OCR_MAX_FRAMES", "240"))
    # Scan denser than OCR budget so we can pick change frames
    scan = all_files[:: max(1, stride // 2 or 1)] if stride > 1 else all_files
    if len(scan) > max_frames * 3:
        step = max(1, len(scan) // (max_frames * 3))
        scan = scan[::step]

    selected: list[Path] = []
    last_sig: bytes | None = None
    for fp in scan:
        try:
            sig = _crop_signature(fp, crop_frac)
        except Exception:  # noqa: BLE001
            sig = b""
        if last_sig is None or _sig_changed(last_sig, sig):
            selected.append(fp)
            last_sig = sig if sig else last_sig
        if len(selected) >= max_frames:
            break
    # Ensure coverage: if change-detect under-selected, fill with stride sample
    if len(selected) < min(max_frames, max(8, len(all_files) // max(stride, 1))):
        for fp in all_files[::stride]:
            if fp not in selected:
                selected.append(fp)
            if len(selected) >= max_frames:
                break
        selected.sort(key=lambda p: p.name)
    return selected[:max_frames]


def try_ocr(recording_id: str, storage_root: str) -> dict:
    frames = Path(storage_root) / "frames" / recording_id
    all_files = sorted(frames.glob("*.jpg")) if frames.is_dir() else []
    if not all_files:
        return _fail(f"no frames in {frames}")

    crop_frac = _parse_crop(DEFAULT_CROP)
    files = _select_ocr_frames(all_files, crop_frac)
    fps = float(os.environ.get("OCR_FPS", "1"))
    engine = (os.environ.get("OCR_ENGINE") or "auto").lower()

    hits: list[tuple[str, str, float]] = []
    backend = "none"
    errors: list[str] = []

    if engine in ("auto", "paddle", "paddleocr"):
        try:
            hits = _ocr_paddle(files, crop_frac)
            backend = "paddleocr"
        except Exception as exc:  # noqa: BLE001
            errors.append(f"paddleocr: {exc}")
            if engine != "auto":
                return _fail(f"paddleocr failed: {exc}")

    if not hits and engine in ("auto", "tesseract"):
        try:
            hits = _ocr_tesseract(files, crop_frac)
            backend = "tesseract"
        except Exception as exc:  # noqa: BLE001
            errors.append(f"tesseract: {exc}")
            return _fail("; ".join(errors) or str(exc))

    if not hits and errors:
        return _fail("; ".join(errors))

    # Fuzzy dedupe near-identical lines (keep earliest offset)
    unique: list[tuple[str, str, float, int]] = []
    for fname, text, conf in hits:
        key = _norm_text(text)
        if len(key) < 2:
            continue
        if any(_near_dup(key, _norm_text(u[1])) for u in unique):
            continue
        unique.append((fname, text, conf, _frame_offset_ms(fname, fps)))

    dsn = os.environ.get("DATABASE_URL")
    inserted = 0
    if dsn:
        import psycopg

        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM observed_comments WHERE recording_id = %s AND source LIKE %s",
                    (recording_id, "ocr_%"),
                )
                for fname, text, conf, offset_ms in unique:
                    cur.execute(
                        """
                        INSERT INTO observed_comments
                          (recording_id, body, source, offset_ms, raw_json)
                        VALUES (%s, %s, %s, %s, %s::jsonb)
                        """,
                        (
                            recording_id,
                            text,
                            f"ocr_{backend}",
                            offset_ms,
                            json.dumps(
                                {
                                    "frame": fname,
                                    "confidence": conf,
                                    "crop": DEFAULT_CROP,
                                }
                            ),
                        ),
                    )
                    inserted += 1
            conn.commit()

    return {
        "ok": True,
        "backend": backend,
        "frames": len(files),
        "framesAvailable": len(all_files),
        "rawHits": len(hits),
        "texts": inserted or len(unique),
        "deduped": len(unique),
        "crop": DEFAULT_CROP,
        "selection": "change_aware",
        "errors": errors or None,
    }


def main() -> None:
    if len(sys.argv) < 4:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "usage: tools.py transcribe|ocr <recordingId> <storageRoot>",
                }
            )
        )
        sys.exit(2)
    action, recording_id, storage_root = sys.argv[1], sys.argv[2], sys.argv[3]
    if action == "transcribe":
        out = try_faster_whisper(recording_id, storage_root)
    elif action == "ocr":
        out = try_ocr(recording_id, storage_root)
    else:
        out = {"ok": False, "error": "unknown action"}
        print(json.dumps(out))
        sys.exit(2)

    print(json.dumps(out))
    if not out.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
