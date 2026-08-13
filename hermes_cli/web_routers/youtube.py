"""YouTube Summarizer dashboard routes.

Flow:
  1. Try the published transcript (skills/media/youtube-content/scripts/
     fetch_transcript.py) first — no reimplementation of YouTube ID parsing.
  2. If the video has no captions, download the audio with yt-dlp and
     transcribe it locally via tools/transcription_tools.transcribe_audio
     (faster-whisper) — covers "audio-only" videos.
  3. Summarize the transcript with the configured LLM through
     ``agent.auxiliary_client`` (same path the curator / session_search use).
  4. Persist the summary to HERMES_HOME/youtube_summaries.json.

Endpoints:
  POST /api/youtube/summarize   { url, lang? }            -> summary object
  GET  /api/youtube/summaries                              -> list
  DELETE /api/youtube/summaries/{id}                       -> 204
"""

import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hermes_constants import get_hermes_home

_log = logging.getLogger("hermes_cli.web_server")

router = APIRouter()

_LOCK = threading.Lock()
_SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "skills",
    "media",
    "youtube-content",
    "scripts",
    "fetch_transcript.py",
)

# Locate a Thai-capable TTF for PDF rendering (Windows ships THSarabunPSK).
def _thai_font() -> Optional[str]:
    candidates = [
        r"C:\Windows\Fonts\THSarabunPSK.ttf",
        r"C:\Windows\Fonts\tahoma.ttf",
        "/usr/share/fonts/truetype/tlwg/Tahoma.ttf",
        "/usr/share/fonts/truetype/thai/Tahoma.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def _make_pdf(item: dict, out_path: str) -> str:
    """Render a YouTube summary to a Thai-capable PDF."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer

    font = _thai_font()
    if font:
        pdfmetrics.registerFont(TTFont("Thai", font))
        base = "Thai"
    else:
        base = "Helvetica"

    doc = SimpleDocTemplate(
        out_path, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=2 * cm, bottomMargin=2 * cm,
    )
    styles = getSampleStyleSheet()
    h = ParagraphStyle("h", parent=styles["Heading1"], fontName=base, fontSize=16)
    meta = ParagraphStyle("meta", parent=styles["Normal"], fontName=base, fontSize=9, textColor="#666666")
    body = ParagraphStyle("body", parent=styles["Normal"], fontName=base, fontSize=12, leading=18)

    flow = [
        Paragraph("YouTube Summary", h),
        Spacer(1, 6),
        Paragraph(f"{item.get('url', '')}<br/>Video: {item.get('video_id', '')}", meta),
        Spacer(1, 12),
        Paragraph((item.get("summary") or "").replace("\n", "<br/>"), body),
    ]
    doc.build(flow)
    return out_path


class YoutubeSummarizeRequest(BaseModel):
    url: str
    lang: Optional[str] = None  # e.g. "en,th" — passed to fetch_transcript


def _path() -> str:
    return str(get_hermes_home() / "youtube_summaries.json")


def _read() -> list:
    try:
        with open(_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception as exc:
        _log.warning("youtube_summaries.json unreadable (%s); empty", exc)
        return []


def _write(items: list) -> None:
    get_hermes_home().mkdir(parents=True, exist_ok=True)
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _path())


def _get_transcript(url: str, lang: Optional[str]) -> dict:
    """Return transcript JSON for a YouTube URL.

    Strategy:
      1. Try the published captions via fetch_transcript.py.
      2. If unavailable, download the audio with yt-dlp and transcribe it
         locally with faster-whisper (tools/transcription_tools).
    """
    if os.path.exists(_SCRIPT):
        out = subprocess.run(
            [sys.executable, _SCRIPT, url, "--timestamps"]
            + (["--language", lang] if lang else []),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if out.returncode == 0:
            try:
                return json.loads(out.stdout)
            except json.JSONDecodeError:
                pass
        # fall through to audio transcription

    # Audio-only fallback: download best audio, transcribe locally.
    from tools.transcription_tools import transcribe_audio

    work = tempfile.mkdtemp(prefix="yt_audio_")
    audio_path = os.path.join(work, "audio.%(ext)s")
    dl = subprocess.run(
        [
            sys.executable,
            "-m",
            "yt_dlp",
            "-f",
            "bestaudio[ext=m4a]/bestaudio/best",
            "-o",
            audio_path,
            "--no-playlist",
            url,
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if dl.returncode != 0:
        raise RuntimeError(
            "ไม่สามารถดาวน์โหลดเสียงวิดีโอได้ (วิดีโออาจเป็นส่วนตัว/ถูกบล็อก): "
            + (dl.stderr.strip()[-300:] or "yt-dlp failed")
        )
    downloaded = None
    for f in os.listdir(work):
        if f.startswith("audio."):
            downloaded = os.path.join(work, f)
            break
    if not downloaded:
        raise RuntimeError("ดาวน์โหลดเสียงแล้วไม่พบไฟล์")

    result = transcribe_audio(downloaded, source="youtube_summarizer")
    if not result.get("success"):
        raise RuntimeError("ถอดเสียงล้มเหลว: " + str(result.get("error", "unknown")))
    text = result.get("transcript") or ""
    if not text.strip():
        raise RuntimeError("ถอดเสียงได้ข้อความว่างเปล่า")
    return {
        "video_id": url,
        "segment_count": 0,
        "duration": "",
        "full_text": text,
    }


def _summarize(transcript_text: str, video_id: str) -> str:
    """Summarize Thai/English transcript via the configured LLM."""
    from agent.auxiliary_client import _resolve_auto

    client, model = _resolve_auto(task="summary")
    if client is None or not model:
        raise RuntimeError(
            "No LLM provider configured. Set a model/provider in Hermes config."
        )
    prompt = (
        "คุณคือผู้ช่วยสรุปเนื้อหาวิดีโอ YouTube。\n"
        "สรุป transcript ด้านล่างเป็นภาษาไทย ให้ครบประเด็นสำคัญ "
        "แบ่งเป็นหัวข้อ + รายการประเด็น สั้นกระชับ อ่านง่าย:\n\n"
        f"{transcript_text[:24000]}"
    )
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )
    summary = (resp.choices[0].message.content or "").strip()
    if not summary:
        raise RuntimeError("LLM returned empty summary (try a shorter transcript or different model).")
    return summary


@router.post("/api/youtube/summarize", status_code=201)
async def youtube_summarize(body: YoutubeSummarizeRequest):
    try:
        data = _get_transcript(body.url, body.lang)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Transcript error: {e}")

    transcript_text = data.get("full_text") or data.get("timestamped_text") or ""
    if not transcript_text.strip():
        raise HTTPException(status_code=400, detail="Empty transcript.")

    try:
        summary = _summarize(transcript_text, data.get("video_id", ""))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Summarize error: {e}")

    item = {
        "id": uuid.uuid4().hex[:12],
        "video_id": data.get("video_id", ""),
        "url": body.url,
        "summary": summary,
        "transcript_len": len(transcript_text),
        "created_at": time.time(),
    }
    with _LOCK:
        items = _read()
        items.insert(0, item)
        _write(items)
    return item


@router.get("/api/youtube/summaries")
async def youtube_summaries():
    with _LOCK:
        return _read()


@router.delete("/api/youtube/summaries/{item_id}", status_code=204)
async def youtube_delete(item_id: str):
    with _LOCK:
        items = _read()
        new = [it for it in items if it.get("id") != item_id]
        if len(new) == len(items):
            raise HTTPException(status_code=404, detail="not found")
        _write(new)
        return None


@router.post("/api/youtube/summaries/{item_id}/send-telegram", status_code=202)
async def youtube_send_telegram(item_id: str):
    """Render the summary to a PDF and send it to Telegram via `hermes send`."""
    with _LOCK:
        items = _read()
        item = next((it for it in items if it.get("id") == item_id), None)
        if not item:
            raise HTTPException(status_code=404, detail="not found")

    work = tempfile.mkdtemp(prefix="yt_pdf_")
    pdf_path = os.path.join(work, f"summary_{item_id}.pdf")
    try:
        _make_pdf(item, pdf_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF error: {e}")

    # Send via the Hermes CLI (uses TELEGRAM_HOME_CHANNEL if configured).
    try:
        msg = f"สรุป YouTube จาก Hermes Dashboard\nMEDIA:{pdf_path}"
        proc = subprocess.run(
            [sys.executable, "-m", "hermes_cli.main", "send",
             "--to", "telegram", msg],
            capture_output=True, text=True, timeout=120,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Send error: {e}")
    if proc.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail=f"Send failed: {proc.stderr.strip()[-300:] or proc.stdout.strip()[-300:]}",
        )
    return {"status": "sent", "pdf": pdf_path}
