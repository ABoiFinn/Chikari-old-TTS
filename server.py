#!/usr/bin/env python
"""Local-only TTS server for the browser extension/userscript.

Wraps the Kokoro engine used by read_chapter.py behind a tiny HTTP API so
the browser extension running on chikari.moe can request synthesized
audio. Binds to 127.0.0.1 only -- not reachable from the network.

Synthesis runs as a background job, chunked by paragraph/sentence, so the
client can poll for real progress instead of waiting on one long request.

Run:
    .\\venv\\Scripts\\python.exe server.py
"""
import io
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import soundfile as sf
from flask import Flask, Response, jsonify, request

ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config.json"

sys.path.insert(0, str(ROOT))
from engines import kokoro_engine  # noqa: E402

app = Flask(__name__)

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
MAX_JOBS = 5

CHUNK_MAX_CHARS = 300

# Synthesize a few chunks at once instead of one at a time. Kokoro's inference
# releases the GIL during the actual model run, so threads give real overlap
# here. Capped well below the machine's core count on purpose -- this is meant
# to speed up chapter synthesis, not to peg every core while it runs.
CHUNK_WORKERS = min(3, os.cpu_count() or 1)
_executor = ThreadPoolExecutor(max_workers=CHUNK_WORKERS, thread_name_prefix="tts-chunk")

# Preloading the next chapter happens quietly while the reader is still busy
# with the current one, so it doesn't need to be fast. One worker instead of
# three keeps it from pegging multiple cores (and spinning up fans) just to
# get a head start -- it'll simply take a few minutes longer than the
# foreground synthesis above, which still gets the full worker pool.
_background_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts-preload")


def load_config() -> dict:
    default = {"voice": "am_michael", "speed": 1.0}
    if CONFIG_PATH.exists():
        try:
            # utf-8-sig strips a UTF-8 BOM if present (e.g. from PowerShell's
            # -Encoding utf8) and behaves like plain utf-8 otherwise.
            default.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig")))
        except (json.JSONDecodeError, OSError):
            pass
    return default


def chunk_text(text: str) -> list[str]:
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
    chunks = []
    for para in paragraphs:
        if len(para) <= CHUNK_MAX_CHARS:
            chunks.append(para)
            continue
        sentences = re.split(r"(?<=[.!?])\s+", para)
        buf = ""
        for sent in sentences:
            if buf and len(buf) + len(sent) + 1 > CHUNK_MAX_CHARS:
                chunks.append(buf)
                buf = sent
            else:
                buf = f"{buf} {sent}".strip()
        if buf:
            chunks.append(buf)
    return chunks or [text]


def _synthesize_one_chunk(engine, voice: str, speed: float, chunk: str, tmp: str, index: int):
    wav_path = Path(tmp) / f"chunk_{index}.wav"
    engine.synthesize(chunk, voice, speed, wav_path)
    samples, sr = sf.read(str(wav_path), dtype="float32")
    return index, samples, sr


def _run_job(job_id: str, futures: list, tmp_dir: str):
    job = JOBS[job_id]
    results: list = [None] * len(futures)
    sample_rate = None
    done_lock = threading.Lock()
    try:
        # Always drain every future to a terminal state before falling through
        # to the tmp_dir cleanup in `finally`, even once cancelled. A future
        # that was already running when /speak/cancel arrived can't actually
        # be stopped -- it keeps writing its chunk's .wav file into tmp_dir in
        # the background regardless. Breaking out early and deleting that
        # directory out from under it can wedge the worker thread, and with
        # only 3 of them total, that's enough to jam the whole pool until the
        # process is restarted. Cancellation is still reported to the client
        # instantly via the flag itself -- this only affects when *this*
        # background thread tidies up, not how fast the API responds.
        for future in as_completed(futures):
            try:
                index, samples, sr = future.result()
            except CancelledError:
                continue
            if job["cancelled"]:
                continue
            results[index] = samples
            sample_rate = sr
            with done_lock:
                job["done"] += 1

        if job["cancelled"]:
            job["status"] = "cancelled"
            return

        sr = sample_rate or 24000
        pieces = []
        for samples in results:
            pieces.append(samples)
            pieces.append(np.zeros(int(sr * 0.2), dtype="float32"))
        audio = np.concatenate(pieces) if pieces else np.zeros(1, dtype="float32")
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV")
        job["audio"] = buf.getvalue()
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001
        if not job["cancelled"]:
            job["status"] = "error"
            job["error"] = str(e)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _prune_jobs():
    with JOBS_LOCK:
        if len(JOBS) > MAX_JOBS:
            oldest = sorted(JOBS.items(), key=lambda kv: kv[1]["created"])[: len(JOBS) - MAX_JOBS]
            for job_id, _ in oldest:
                JOBS.pop(job_id, None)


@app.get("/health")
def health():
    return jsonify(ok=True)


@app.get("/voices")
def voices():
    return jsonify(kokoro=sorted(kokoro_engine._get_kokoro().get_voices()))


@app.post("/speak/start")
def speak_start():
    cfg = load_config()
    data = request.get_json(force=True)
    text = data.get("text", "")
    if not text.strip():
        return jsonify(error="empty text"), 400

    voice = data.get("voice", cfg["voice"])
    speed = float(data.get("speed", cfg["speed"]))
    background = bool(data.get("background", False))

    chunks = chunk_text(text)
    job_id = uuid.uuid4().hex
    tmp_dir = tempfile.mkdtemp(prefix=f"tts-{job_id}-")
    executor = _background_executor if background else _executor

    # Submit every chunk to the pool right here, synchronously, before this
    # request even returns. That way job["futures"] is fully populated the
    # instant the client learns the job_id -- no window where a /speak/cancel
    # that arrives quickly could find an empty list and cancel nothing.
    futures = [
        executor.submit(_synthesize_one_chunk, kokoro_engine, voice, speed, chunk, tmp_dir, i)
        for i, chunk in enumerate(chunks)
    ]

    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "running",
            "done": 0,
            "total": len(chunks),
            "created": time.time(),
            "audio": None,
            "error": None,
            "cancelled": False,
            "futures": futures,
        }
    threading.Thread(target=_run_job, args=(job_id, futures, tmp_dir), daemon=True).start()
    _prune_jobs()
    return jsonify(job_id=job_id, total=len(chunks))


@app.get("/speak/progress/<job_id>")
def speak_progress(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify(error="unknown job"), 404
    return jsonify(status=job["status"], done=job["done"], total=job["total"], error=job["error"])


@app.post("/speak/cancel/<job_id>")
def speak_cancel(job_id):
    job = JOBS.get(job_id)
    if job:
        job["cancelled"] = True
        for future in job.get("futures", []):
            future.cancel()
    return jsonify(ok=True)


@app.get("/speak/audio/<job_id>")
def speak_audio(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify(error="unknown job"), 404
    if job["status"] == "error":
        return jsonify(error=job["error"]), 500
    if job["status"] != "done":
        return jsonify(error="not ready"), 409
    return Response(job["audio"], mimetype="audio/wav")


def _make_tray_image():
    from PIL import Image, ImageDraw

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((2, 2, size - 2, size - 2), fill=(255, 0, 79, 255))
    draw.polygon([(23, 17), (23, 47), (48, 32)], fill=(255, 255, 255, 255))
    return img


def _run_with_tray_icon():
    import pystray
    from pystray import MenuItem

    def close_server(icon, _item):
        icon.stop()
        os._exit(0)

    menu = pystray.Menu(
        MenuItem("Chikari Local Reader - running", None, enabled=False),
        pystray.Menu.SEPARATOR,
        MenuItem("Close Server", close_server),
    )
    icon = pystray.Icon("chikari-local-reader", _make_tray_image(), "Chikari Local Reader", menu)
    icon.run()


if __name__ == "__main__":
    # pythonw.exe (used so no console window ever appears) sets stdout/stderr
    # to None, which makes any print() -- ours or Flask/Werkzeug's own startup
    # messages -- crash immediately. Redirect to a log file instead whenever
    # there's no real console to write to.
    if sys.stdout is None:
        log_file = open(ROOT / "server.log", "a", buffering=1)
        sys.stdout = sys.stderr = log_file

    print("Local TTS server on http://127.0.0.1:8791")

    threading.Thread(
        target=lambda: app.run(host="127.0.0.1", port=8791, threaded=True, use_reloader=False),
        daemon=True,
    ).start()

    # Kokoro only builds its onnxruntime session on first use, which takes
    # 15-20s -- during which the very first chunk of the very first chapter
    # has nothing to show, indistinguishable from being stuck at 0%. Load it
    # now instead, in the background, so that tax is paid at startup (while
    # you're still finding the extension and opening a chapter) rather than
    # the moment you press Play.
    def _warm_up_model():
        try:
            kokoro_engine._get_kokoro()
            print("Voice model loaded and ready.")
        except Exception as e:  # noqa: BLE001
            print(f"Voice model warm-up failed (will load on first request instead): {e}")

    threading.Thread(target=_warm_up_model, daemon=True).start()

    try:
        _run_with_tray_icon()
    except Exception as e:  # noqa: BLE001
        # pystray/Pillow missing, no attached desktop session, or any other
        # environment issue -- fall back to a plain console loop rather than
        # taking the whole server down over a tray icon failing to appear.
        print(f"(Tray icon unavailable ({e}) -- running without one.)")
        print("Ctrl+C to stop.")
        while True:
            time.sleep(3600)
