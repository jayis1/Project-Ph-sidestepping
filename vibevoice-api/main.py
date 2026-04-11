import os
import io
import torch
import numpy as np
import scipy.io.wavfile
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.responses import Response
from pydantic import BaseModel
from transformers import pipeline

app = FastAPI()

# Only load models on startup if they are needed, or load them globally
device = "cuda:0" if torch.cuda.is_available() else "cpu"
print(f"Loading models on {device}...")

# Hugging face pipelines for STT and TTS
asr_pipe = None
tts_pipe = None

def init_models():
    global asr_pipe, tts_pipe
    
    # Load ASR
    try:
        print("Loading VibeVoice-ASR in float16...")
        # Add trust_remote_code=True just in case it's a custom architecture
        asr_pipe = pipeline("automatic-speech-recognition", model="microsoft/VibeVoice-ASR", device=device, trust_remote_code=True, torch_dtype=torch.float16)
        print("VibeVoice ASR loaded successfully.")
    except Exception as e:
        print(f"Warning: Failed to load VibeVoice-ASR - {e}")
        
    # Load TTS
    try:
        print("Loading VibeVoice-Realtime in float16...")
        tts_pipe = pipeline("text-to-speech", model="microsoft/VibeVoice-Realtime-0.5B", device=device, trust_remote_code=True, torch_dtype=torch.float16)
        print("VibeVoice Realtime TTS loaded successfully.")
    except Exception as e:
        print(f"Warning: Failed to load VibeVoice-Realtime-0.5B - {e}")

class TTSRequest(BaseModel):
    model: str = "kokoro"
    input: str
    voice: str = "af_heart"
    response_format: str = "wav"

@app.on_event("startup")
async def startup_event():
    init_models()

@app.get("/health")
async def health_check():
    return {"status": "ok"}

@app.get("/v1/models")
async def get_models():
    return {"data": [{"id": "vibevoice", "object": "model"}]}

@app.post("/v1/audio/speech")
async def create_speech(request: TTSRequest):
    if not tts_pipe:
        raise HTTPException(status_code=500, detail="TTS pipeline not loaded.")
    
    text = request.input
    try:
        # Generate audio using huggingface pipeline
        output = tts_pipe(text)
        # Output format is usually a dict: {"audio": numpy_array, "sampling_rate": int}
        audio_np = output["audio"]
        sr = output["sampling_rate"]
        
        # Squeeze in case shape is (1, N)
        audio_np = audio_np.squeeze()
        
        # Convert audio to wav format bytes
        wav_io = io.BytesIO()
        scipy.io.wavfile.write(wav_io, sr, audio_np)
        return Response(content=wav_io.getvalue(), media_type="audio/wav")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/v1/audio/transcriptions")
async def create_transcription(file: UploadFile = File(...), model: str = Form("whisper-1"), language: str = Form(None)):
    if not asr_pipe:
        raise HTTPException(status_code=500, detail="ASR pipeline not loaded.")
    
    try:
        audio_bytes = await file.read()
        
        import tempfile
        import os
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
            
        try:
            output = asr_pipe(tmp_path)
            text = output.get("text", "")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
                
        return {"text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    # If run directly
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False)
