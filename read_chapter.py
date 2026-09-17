#!/usr/bin/env python
"""Fetch chikari.moe chapters and read them aloud locally.

Usage:
    python read_chapter.py https://chikari.moe/novels/shadow-slave/30
    python read_chapter.py https://chikari.moe/novels/shadow-slave/30 --no-auto-advance
    python read_chapter.py https://chikari.moe/novels/shadow-slave/30 --voice af_bella
    python read_chapter.py --text "some text to read"

Defaults (voice, speed, auto-advance) come from config.json and can be
overridden per-run with flags.
"""
import argparse
import json
import re
import sys
import tempfile
import winsound
from pathlib import Path

import requests

from engines import kokoro_engine

ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config.json"

CHAPTER_URL_RE = re.compile(r"chikari\.moe/novels/([^/]+)/([0-9.]+)")


def load_config() -> dict:
    default = {"voice": "am_michael", "speed": 1.0, "auto_advance": True}
    if CONFIG_PATH.exists():
        try:
            default.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig")))
        except (json.JSONDecodeError, OSError):
            pass
    return default


def fetch_chapter_text(slug: str, number: str) -> str:
    api_url = f"https://chikari.moe/api/novels/{slug}/chapters/{number}/read"
    resp = requests.get(api_url, timeout=30)
    resp.raise_for_status()
    return clean_text(resp.json()["body"])


def clean_text(body: str) -> str:
    lines = [ln for ln in body.splitlines() if not re.fullmatch(r"[\s*_-]+", ln.strip() or "x")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def next_chapter_number(number: str) -> str:
    value = float(number) + 1
    return str(int(value)) if value.is_integer() else str(value)


def play_text(text: str, voice: str, speed: float) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "out.wav"
        print(f"Synthesizing with {voice} at {speed}x...")
        kokoro_engine.synthesize(text, voice, speed, wav_path)
        print("Playing...")
        winsound.PlaySound(str(wav_path), winsound.SND_FILENAME)


def main():
    cfg = load_config()

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", nargs="?", help="chikari.moe chapter URL")
    parser.add_argument("--text", help="Raw text to read instead of fetching a chapter")
    parser.add_argument("--voice", default=cfg["voice"])
    parser.add_argument("--speed", type=float, default=cfg["speed"])
    parser.add_argument(
        "--auto-advance", dest="auto_advance", action="store_true", default=cfg["auto_advance"],
        help="Keep playing subsequent chapters until interrupted or a chapter is missing",
    )
    parser.add_argument("--no-auto-advance", dest="auto_advance", action="store_false")
    args = parser.parse_args()

    if args.text:
        play_text(args.text, args.voice, args.speed)
        return

    if not args.url:
        parser.error("Provide either a chapter URL or --text")

    m = CHAPTER_URL_RE.search(args.url)
    if not m:
        sys.exit(f"Could not parse a chikari.moe chapter URL from: {args.url}")
    slug, number = m.group(1), m.group(2)

    while True:
        print(f"\n=== {slug} chapter {number} ===")
        try:
            text = fetch_chapter_text(slug, number)
        except requests.HTTPError as e:
            if args.auto_advance:
                print(f"Stopping: chapter {number} not available ({e}).")
                return
            raise

        try:
            play_text(text, args.voice, args.speed)
        except KeyboardInterrupt:
            print("\nStopped.")
            return

        if not args.auto_advance:
            return
        number = next_chapter_number(number)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
