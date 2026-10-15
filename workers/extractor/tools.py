#!/usr/bin/env python3
"""Local ASR (faster-whisper) + OCR (Tesseract / PaddleOCR) for mezatizle.

IG Live DASH masters usually do NOT burn the comment UI into the video.
OCR still targets the bottom-left comment stack (portrait) for any overlay
that is present, and parses @username / aldım / bids when readable.
Live follower comments should also be captured via the Playwright live API
while the broadcast is active.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# Instagram Live (portrait): comments scroll bottom-LEFT over the video.
# Right side is usually the product presentation — do NOT OCR there as comments.
DEFAULT_CROP = os.environ.get("OCR_CROP_FRAC", "0.02,0.48,0.62,0.94")

USER_RE = re.compile(r"@([A-Za-z0-9._]{2,30})")
# username-like token without @ (IG overlay sometimes drops the @ glyph)
BARE_USER_RE = re.compile(r"(?<![A-Za-z0-9._])([A-Za-z][A-Za-z0-9._]{2,29})(?![A-Za-z0-9._])")
ALDIM_RE = re.compile(r"ald[ıiİI]m", re.I)
STOP_USERS = {
    "instagram",
    "meta",
    "live",
    "reel",
    "aldım",
    "aldim",
    "veririm",
    "lira",
    "bin",
    "dostlar",
    "tamam",
}


def _parse_crop(raw: str) -> tuple[float, float, float, float]:
    parts = [float(x.strip()) for x in raw.split(",")]
    if len(parts) != 4:
        return (0.02, 0.48, 0.62, 0.94)
    return (parts[0], parts[1], parts[2], parts[3])


def _norm_text(s: str) -> str:
    t = re.sub(r"\s+", " ", (s or "").strip().lower())
    t = t.replace("ı", "i").replace("ğ", "g").replace("ü", "u")
    t = t.replace("ş", "s").replace("ö", "o").replace("ç", "c")
    return t


def _near_dup(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    if a in b or b in a:
        return abs(len(a) - len(b)) <= max(4, int(0.35 * max(len(a), len(b))))
    ta, tb = set(a.split()), set(b.split())
    if not ta or not tb:
        return False
    inter = len(ta & tb)
    union = len(ta | tb)
    return union > 0 and inter / union >= 0.85


def _crop_signature(fp: Path, crop_frac: tuple[float, float, float, float]) -> bytes:
    from PIL import Image

    img = Image.open(fp).convert("L")
    cropped = _crop_image(img, crop_frac)
    thumb = cropped.resize((48, 32), Image.Resampling.BILINEAR)
    return thumb.tobytes()


def _sig_changed(a: bytes, b: bytes, threshold: float = 0.06) -> bool:
    if not a or not b or len(a) != len(b):
        return True
    diff = sum(1 for x, y in zip(a, b) if abs(x - y) > 18)
    return (diff / len(a)) >= threshold


def _frame_offset_ms(name: str, fps: float) -> int:
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

    model_size = os.environ.get("WHISPER_MODEL", "small")
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
    box = (int(w * l), int(h * t), int(w * r), int(h * b))
    if box[2] <= box[0] or box[3] <= box[1]:
        return img
    return img.crop(box)


def parse_comment_line(text: str) -> tuple[str | None, str]:
    """Extract optional author username + cleaned body. Never invent usernames."""
    raw = (text or "").strip()
    if len(raw) < 2:
        return None, raw

    author: str | None = None
    m = USER_RE.search(raw)
    if m:
        cand = m.group(1).lower()
        if cand not in STOP_USERS and not ALDIM_RE.fullmatch(cand):
            author = cand

    body = USER_RE.sub(" ", raw)
    body = re.sub(r"\s+", " ", body).strip()

    # "username aldım" without @ — only if second token looks like a claim/bid
    if author is None:
        parts = body.split()
        if len(parts) >= 2:
            maybe = parts[0]
            rest = " ".join(parts[1:])
            if (
                BARE_USER_RE.fullmatch(maybe)
                and maybe.lower() not in STOP_USERS
                and (
                    ALDIM_RE.search(rest)
                    or re.search(r"\d{2,7}|veririm|\+", rest, re.I)
                )
            ):
                author = maybe.lower()
                body = rest

    # Drop obvious OCR garbage bodies
    letters = len(re.findall(r"[A-Za-zÀ-ÿĞğÜüŞşİıÖöÇç]", body))
    digits = len(re.findall(r"\d", body))
    if author is None and letters + digits < 3:
        return None, ""
    if author is None and letters < 2 and not re.search(r"\d{2,}", body):
        # keep short bid amounts like "500"
        if not re.fullmatch(r"\+?\d{2,7}", body.replace(" ", "")):
            return None, ""

    return author, body or raw


def _preprocess_comment_crop(cropped):
    """Upscale + contrast for small white IG overlay text on dark video."""
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps

    img = cropped.convert("L")
    scale = float(os.environ.get("OCR_UPSCALE", "2.0"))
    if scale > 1.01:
        img = img.resize(
            (max(1, int(img.width * scale)), max(1, int(img.height * scale))),
            Image.Resampling.LANCZOS,
        )
    max_w = int(os.environ.get("OCR_MAX_WIDTH", "480"))
    max_h = int(os.environ.get("OCR_MAX_HEIGHT", "640"))
    if img.width > max_w or img.height > max_h:
        ratio = min(max_w / img.width, max_h / img.height)
        img = img.resize(
            (max(1, int(img.width * ratio)), max(1, int(img.height * ratio))),
            Image.Resampling.LANCZOS,
        )
    img = ImageOps.autocontrast(img, cutoff=1)
    img = ImageEnhance.Contrast(img).enhance(
        float(os.environ.get("OCR_CONTRAST", "1.8"))
    )
    img = img.filter(ImageFilter.SHARPEN)
    return img


def _ocr_paddle(files: list[Path], crop_frac) -> list[tuple[str, str, float]]:
    from paddleocr import PaddleOCR  # type: ignore
    from PIL import Image

    ocr = PaddleOCR(
        use_angle_cls=True,
        lang=os.environ.get("PADDLE_LANG", "en"),
        show_log=False,
        use_gpu=False,
    )
    out: list[tuple[str, str, float]] = []
    for fp in files:
        img = Image.open(fp).convert("RGB")
        cropped = _preprocess_comment_crop(_crop_image(img, crop_frac)).convert(
            "RGB"
        )
        tmp = fp.parent / f".ocr_{fp.name}"
        cropped.save(tmp, quality=92)
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
    from PIL import Image

    # tur+eng when available — usernames ASCII + Turkish aldım/lira
    lang = os.environ.get("TESSERACT_LANG", "tur+eng")
    # PSM 6 = block; 11 = sparse text (IG overlays)
    config = os.environ.get("TESSERACT_CONFIG", "--psm 6 --oem 1")
    timeout_s = float(os.environ.get("OCR_FRAME_TIMEOUT_S", "12"))
    out: list[tuple[str, str, float]] = []
    for fp in files:
        img = Image.open(fp)
        cropped = _preprocess_comment_crop(_crop_image(img, crop_frac))
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
                # Fallback eng-only sparse (faster) if tur+eng times out
                try:
                    subprocess.run(
                        [
                            "tesseract",
                            str(png),
                            str(base),
                            "-l",
                            "eng",
                            "--psm",
                            "11",
                            "--oem",
                            "1",
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
                out.append((fp.name, line, 0.55))
    return out


def _select_ocr_frames(
    all_files: list[Path], crop_frac: tuple[float, float, float, float]
) -> list[Path]:
    """Denser sampling when the comment-region crop changes."""
    if not all_files:
        return []
    stride = max(1, int(os.environ.get("OCR_FRAME_STRIDE", "2")))
    max_frames = int(os.environ.get("OCR_MAX_FRAMES", "320"))
    # Scan denser so we catch brief aldım flashes
    scan_step = max(1, stride // 2)
    scan = all_files[::scan_step]
    if len(scan) > max_frames * 4:
        step = max(1, len(scan) // (max_frames * 4))
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
    engine = (os.environ.get("OCR_ENGINE") or "tesseract").lower()

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

    # Parse + fuzzy dedupe (keep earliest offset); prefer lines with author/aldım
    unique: list[tuple[str, str, float, int, str | None]] = []
    for fname, text, conf in hits:
        author, body = parse_comment_line(text)
        if not body:
            continue
        key = _norm_text(f"{author or ''}:{body}")
        if len(key) < 2:
            continue
        if any(_near_dup(key, _norm_text(f"{u[4] or ''}:{u[1]}")) for u in unique):
            continue
        unique.append((fname, body, conf, _frame_offset_ms(fname, fps), author))

    dsn = os.environ.get("DATABASE_URL")
    inserted = 0
    with_author = 0
    aldimish = 0
    if dsn:
        import psycopg

        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM observed_comments WHERE recording_id = %s AND source LIKE %s",
                    (recording_id, "ocr_%"),
                )
                for fname, body, conf, offset_ms, author in unique:
                    if author:
                        with_author += 1
                    if ALDIM_RE.search(body):
                        aldimish += 1
                    cur.execute(
                        """
                        INSERT INTO observed_comments
                          (recording_id, body, author_username, source, offset_ms, raw_json)
                        VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                        """,
                        (
                            recording_id,
                            body,
                            author,
                            f"ocr_{backend}",
                            offset_ms,
                            json.dumps(
                                {
                                    "frame": fname,
                                    "confidence": conf,
                                    "crop": DEFAULT_CROP,
                                    "parsedAuthor": author,
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
        "withAuthor": with_author,
        "aldimish": aldimish,
        "crop": DEFAULT_CROP,
        "selection": "change_aware_left_comments",
        "errors": errors or None,
        "note": (
            "DASH masters often lack IG comment UI overlays; "
            "prefer live API comment capture while broadcast is active."
        ),
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
