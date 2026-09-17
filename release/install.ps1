# Chikari Local Reader - one-time setup
# Sets up Python, the required packages, and downloads the Kokoro voice model.
# Safe to re-run - it skips anything already installed/downloaded.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

function Section($text) {
    Write-Host ""
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

Section "Checking Python"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
$pythonOk = $false
try {
    $v = python --version 2>&1
    if ($v -match "Python 3\.(1[0-9]|[1-9][0-9])") { $pythonOk = $true }
} catch {}

if (-not $pythonOk) {
    Write-Host "Python not found - installing Python 3.12 (this may take a minute)..."
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
} else {
    Write-Host "Python already installed: $v"
}

Section "Setting up the app environment"
if (-not (Test-Path "$root\venv")) {
    python -m venv "$root\venv"
    Write-Host "Created virtual environment."
} else {
    Write-Host "Virtual environment already exists."
}

& "$root\venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
& "$root\venv\Scripts\python.exe" -m pip install --quiet kokoro-onnx soundfile flask requests
Write-Host "Python packages installed."

Section "Downloading the voice model (about 350 MB, one time only)"
New-Item -ItemType Directory -Force -Path "$root\models" | Out-Null
$base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

if (-not (Test-Path "$root\models\kokoro-v1.0.onnx")) {
    Write-Host "Downloading voice engine..."
    Invoke-WebRequest -Uri "$base/kokoro-v1.0.onnx" -OutFile "$root\models\kokoro-v1.0.onnx"
} else {
    Write-Host "Voice engine already downloaded."
}

if (-not (Test-Path "$root\models\voices-v1.0.bin")) {
    Write-Host "Downloading voice list..."
    Invoke-WebRequest -Uri "$base/voices-v1.0.bin" -OutFile "$root\models\voices-v1.0.bin"
} else {
    Write-Host "Voice list already downloaded."
}

Section "Writing default settings"
if (-not (Test-Path "$root\config.json")) {
    $configJson = @'
{
    "voice": "am_michael",
    "speed": 1.0,
    "auto_advance": true
}
'@
    # Set-Content -Encoding utf8 writes a BOM on Windows PowerShell 5.1, which
    # breaks Python's json.loads() on it. Write plain UTF-8 without one.
    [System.IO.File]::WriteAllText("$root\config.json", $configJson)
    Write-Host "Created config.json with default voice (Michael)."
} else {
    Write-Host "config.json already exists, leaving it as is."
}

Section "All done!"
Write-Host "Next steps:" -ForegroundColor Green
Write-Host "  1. Double-click 'Start Server.bat' (keep its window open while reading)."
Write-Host "  2. Load the 'extension' folder as an unpacked Chrome extension."
Write-Host "  3. Open a chapter on chikari.moe and click Play in the panel."
Write-Host ""
Read-Host "Press Enter to close this window"
