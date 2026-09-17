# Chikari Local Reader

Adds a Play button to [chikari.moe](https://chikari.moe) chapters that reads them aloud using [Kokoro](https://github.com/hexgrad/Kokoro-82M), a free TTS model that runs entirely on your own machine — no cloud API, nothing uploaded.

Two pieces, both local: a Chrome extension that shows the player and grabs the chapter text, and a small Python server that turns that text into speech.

## Install

Grab the latest release zip from the [Releases](../../releases) page, unzip it, then:

1. Double-click `Install.bat`. Installs Python if missing, downloads the voice model (~350 MB).
2. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the `extension` folder.
3. Double-click `Start Server.bat`. Keep the window open while reading.
4. Open any chapter on chikari.moe and hit Play, bottom-right.

Full guide with troubleshooting: see [`setup_guide.html`](setup_guide.html) (open locally in a browser).

## Repo layout

- `release/` — the distributable package (what's zipped for Releases): `server.py`, `engines/`, `extension/`, `install.ps1`, `Install.bat`, `Start Server.bat`.
- `extension/`, `engines/`, `server.py` — working copies used for development; kept in sync with `release/`.
- `chikari-local-reader.user.js` — Tampermonkey userscript alternative to the extension, same functionality.
- `read_chapter.py` — standalone CLI: `python read_chapter.py <chapter-url>` reads a chapter aloud without the browser extension.

## How it works

The extension fetches chapter text the same way chikari.moe's own page does, sends it to the local server, which synthesizes audio with Kokoro and returns it for playback. Nothing leaves your machine except the normal page request to chikari.moe itself.

## Requirements

Windows 10/11, Google Chrome (or another Chromium browser), ~400 MB free disk space.
