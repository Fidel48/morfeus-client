"""
kokoro_server.py - Local Kokoro Neural TTS Server for Morfeus

Provides a lightweight, OpenAI-compatible local text-to-speech HTTP server.
Runs on port 8880.
"""

import io
import os
import sys
import urllib.request
from pathlib import Path

MODEL_FILENAME = "kokoro-v1.0.onnx"
VOICES_FILENAME = "voices-v1.0.bin"
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"


def resolve_kokoro_model_paths() -> tuple[Path, Path]:
    home = Path.home()
    candidates: list[Path] = []

    env_dir = os.environ.get("MORFEUS_KOKORO_MODEL_DIR")
    if env_dir:
        candidates.append(Path(env_dir))

    script_base = Path(__file__).resolve().parent.parent
    candidates.extend([
        script_base / "models" / "kokoro",
        Path(__file__).resolve().parent / "models" / "kokoro",
        home / ".morfeus" / "models" / "kokoro",
        home / "Library" / "Application Support" / "com.morfeus.app" / "models" / "kokoro",
        home / "Documents" / "projects" / "morfeus" / "models" / "kokoro",
        home / "projects" / "morfeus" / "models" / "kokoro",
        home / "Desktop" / "morfeus" / "models" / "kokoro",
    ])

    for folder in candidates:
        m_path = folder / MODEL_FILENAME
        v_path = folder / VOICES_FILENAME
        if m_path.exists() and v_path.exists():
            return m_path, v_path

    # Fallback: auto-download model files into ~/.morfeus/models/kokoro for standalone packaged installs
    target_dir = home / ".morfeus" / "models" / "kokoro"
    target_dir.mkdir(parents=True, exist_ok=True)
    m_path = target_dir / MODEL_FILENAME
    v_path = target_dir / VOICES_FILENAME

    try:
        if not m_path.exists():
            print(f"[Kokoro Server] Downloading {MODEL_FILENAME} to {m_path}...", file=sys.stderr)
            tmp_m = target_dir / f"{MODEL_FILENAME}.part"
            urllib.request.urlretrieve(MODEL_URL, str(tmp_m))
            tmp_m.replace(m_path)
        if not v_path.exists():
            print(f"[Kokoro Server] Downloading {VOICES_FILENAME} to {v_path}...", file=sys.stderr)
            tmp_v = target_dir / f"{VOICES_FILENAME}.part"
            urllib.request.urlretrieve(VOICES_URL, str(tmp_v))
            tmp_v.replace(v_path)
    except Exception as dl_err:
        print(f"[Kokoro Server] Failed to auto-download Kokoro model files: {dl_err}", file=sys.stderr)

    return m_path, v_path


MODEL_PATH, VOICES_PATH = resolve_kokoro_model_paths()

if not MODEL_PATH.exists() or not VOICES_PATH.exists():
    print(f"[Kokoro Server] Error: Model files not found at {MODEL_PATH} or {VOICES_PATH}", file=sys.stderr)
    sys.exit(1)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel
import soundfile as sf
from kokoro_onnx import Kokoro

print(f"[Kokoro Server] Initializing Kokoro TTS from {MODEL_PATH}...")
kokoro = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
print("[Kokoro Server] Kokoro TTS initialized successfully!")

app = FastAPI(title="Morfeus Kokoro TTS Server")

# Allow all origins (for Tauri frontend)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SpeechRequest(BaseModel):
    input: str
    voice: str = "af_heart"
    speed: float = 1.0
    lang: str = "en-us"

class PreviewRequest(BaseModel):
    voice: str = "af_heart"
    speed: float = 1.0

@app.get("/health")
def health():
    return {"status": "ok", "model": "kokoro-v1.0", "default_voice": "af_heart"}

@app.get("/v1/voices")
def list_voices():
    # Return list of standard Kokoro voices
    voices = [
        "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky",
        "af_aoede", "af_jessica", "af_kore", "af_river",
        "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck",
        "bf_emma", "bf_alice", "bf_isabella", "bf_lily",
        "bm_george", "bm_lewis", "bm_daniel", "bm_fable"
    ]
    return {"voices": voices}

def synthesize_to_wav_bytes(text: str, voice: str, speed: float = 1.0) -> bytes:
    # Determine language from voice prefix: af_ / am_ -> en-us, bf_ / bm_ -> en-gb
    lang = "en-gb" if voice.startswith("b") else "en-us"
    samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
    buffer = io.BytesIO()
    sf.write(buffer, samples, sample_rate, format="WAV")
    return buffer.getvalue()

@app.post("/v1/audio/speech")
def create_speech(req: SpeechRequest):
    if not req.input.strip():
        raise HTTPException(status_code=400, detail="Text input is required")
    try:
        wav_bytes = synthesize_to_wav_bytes(req.input, req.voice, req.speed)
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        print(f"[Kokoro Server] Speech generation error: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/preview")
def preview_voice(req: PreviewRequest):
    voice_name = req.voice.split("_")[-1].capitalize()
    phrase = f"Hello! I am {voice_name}, your Morfeus AI voice."
    try:
        wav_bytes = synthesize_to_wav_bytes(phrase, req.voice, req.speed)
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as e:
        print(f"[Kokoro Server] Preview error: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("KOKORO_PORT", 8880))
    print(f"[Kokoro Server] Starting HTTP server on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
