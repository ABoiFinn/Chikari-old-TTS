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
        for future in as_completed(futures):
            if job["cancelled"]:
                break
            try:
                index, samples, sr = future.result()
            except CancelledError:
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

    chunks = chunk_text(text)
    job_id = uuid.uuid4().hex
    tmp_dir = tempfile.mkdtemp(prefix=f"tts-{job_id}-")

    # Submit every chunk to the pool right here, synchronously, before this
    # request even returns. That way job["futures"] is fully populated the
    # instant the client learns the job_id -- no window where a /speak/cancel
    # that arrives quickly could find an empty list and cancel nothing.
    futures = [
        _executor.submit(_synthesize_one_chunk, kokoro_engine, voice, speed, chunk, tmp_dir, i)
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


if __name__ == "__main__":
    print("Local TTS server on http://127.0.0.1:8791 (Ctrl+C to stop)")
    app.run(host="127.0.0.1", port=8791, threaded=True)
