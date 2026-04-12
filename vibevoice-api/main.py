import os
import io
import torch
import numpy as np
import scipy.io.wavfile
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import transformers.models.auto.auto_factory
import transformers.models.auto.configuration_auto
import transformers.models.auto.processing_auto

# --- PREVENT CONFLICTS BETWEEN HUGGINGFACE AND MICROSOFT REPO ---
_orig_model_reg = transformers.models.auto.auto_factory._BaseAutoModelClass.register
@classmethod
def _safe_model_reg(cls, *args, **kwargs):
    kwargs['exist_ok'] = True
    try: return _orig_model_reg.__func__(cls, *args, **kwargs)
    except Exception: pass
transformers.models.auto.auto_factory._BaseAutoModelClass.register = _safe_model_reg

_orig_conf_reg = transformers.models.auto.configuration_auto.AutoConfig.register
@classmethod
def _safe_conf_reg(cls, *args, **kwargs):
    kwargs['exist_ok'] = True
    try: return _orig_conf_reg.__func__(cls, *args, **kwargs)
    except Exception: pass
transformers.models.auto.configuration_auto.AutoConfig.register = _safe_conf_reg

if hasattr(transformers.models.auto.processing_auto.AutoProcessor, 'register'):
    _orig_proc_reg = transformers.models.auto.processing_auto.AutoProcessor.register
    @classmethod
    def _safe_proc_reg(cls, *args, **kwargs):
        kwargs['exist_ok'] = True
        try: return _orig_proc_reg.__func__(cls, *args, **kwargs)
        except Exception: pass
    transformers.models.auto.processing_auto.AutoProcessor.register = _safe_proc_reg
# ----------------------------------------------------------------

app = FastAPI()

# ASR Models
asr_processor = None
asr_model = None

# TTS Models
tts_processor = None
tts_model = None
tts_prefilled = None

def init_models():
    global asr_processor, asr_model, tts_processor, tts_model, tts_prefilled
    
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"Loading models on {device}...")

    # ----- LOAD ASR -----
    try:
        from transformers import AutoProcessor, VibeVoiceAsrForConditionalGeneration
        asr_id = "microsoft/VibeVoice-ASR-HF"
        print("Loading VibeVoice-ASR-HF...")
        asr_processor = AutoProcessor.from_pretrained(asr_id)
        asr_model = VibeVoiceAsrForConditionalGeneration.from_pretrained(asr_id, torch_dtype=torch.float16)
        
        if device.startswith("cuda"):
            asr_model.to(device)
        print("VibeVoice ASR loaded successfully.")
    except Exception as e:
        print(f"Warning: Failed to load VibeVoice-ASR - {e}")
        import traceback
        traceback.print_exc()

    # ----- LOAD TTS -----
    try:
        print("Loading VibeVoice-Realtime in bfloat16 using bespoke repository...")
        import sys
        sys.path.append("/app/VibeVoice")
        
        from vibevoice.modular.modeling_vibevoice_streaming_inference import VibeVoiceStreamingForConditionalGenerationInference
        from vibevoice.processor.vibevoice_streaming_processor import VibeVoiceStreamingProcessor
        
        tts_id = "microsoft/VibeVoice-Realtime-0.5B"
        tts_processor = VibeVoiceStreamingProcessor.from_pretrained(tts_id)
        # Using sdpa because flash_attention_2 might crash natively inside standard Docker without explicit CUDA compilation
        tts_model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
            tts_id,
            torch_dtype=torch.float32 if device == "cpu" else torch.bfloat16,
            device_map=None,
            attn_implementation="sdpa",
            _fast_init=False
        )
        if device.startswith("cuda"):
            tts_model.to(device)
        tts_model.eval()
        tts_model.set_ddpm_inference_steps(num_steps=5)
        
        # Load Voice Preset
        voice_preset = "/app/VibeVoice/voices/streaming_model/en-Carter_man.pt"
        if os.path.exists(voice_preset):
            tts_prefilled = torch.load(voice_preset, map_location=device, weights_only=False)
            print("Loaded Carter_man preset successfully.")
        else:
            print("WARNING: Preset not found at", voice_preset)
            
        print("VibeVoice Realtime TTS loaded successfully.")
        print("VibeVoice Realtime TTS loaded successfully.")
    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"Warning: Failed to load VibeVoice-Realtime TTS - {e}")
        print(error_trace)
        global cached_tts_error
        cached_tts_error = error_trace

class TTSRequest(BaseModel):
    model: str = "vibevoice"
    input: str
    voice: str = "default"
    response_format: str = "wav"

@app.on_event("startup")
async def startup_event():
    init_models()

@app.get("/health")
async def health_check():
    return {"status": "ok"}

@app.get("/v1/models")
async def get_models():
    return {"data": [
        {"id": "vibevoice", "object": "model"}
    ]}

@app.post("/v1/audio/speech")
async def create_speech(request: TTSRequest):
    if not tts_model or not tts_processor or not tts_prefilled:
        global cached_tts_error
        err_msg = globals().get("cached_tts_error", "Unknown initialization error.")
        raise HTTPException(status_code=500, detail=f"VibeVoice Error: {err_msg}")
    
    text = request.input
    device = tts_model.device
    
    try:
        import copy
        inputs = tts_processor.process_input_with_cached_prompt(
            text=text.strip(),
            cached_prompt=tts_prefilled,
            padding=True,
            return_tensors="pt",
            return_attention_mask=True,
        )
        
        inputs = {k: v.to(device) if hasattr(v, "to") else v for k, v in inputs.items()}
        
        outputs = tts_model.generate(
            **inputs,
            max_new_tokens=None,
            cfg_scale=1.5,
            tokenizer=tts_processor.tokenizer,
            generation_config={"do_sample": False},
            verbose=False,
            all_prefilled_outputs=copy.deepcopy(tts_prefilled)
        )
        
        if not outputs.speech_outputs or outputs.speech_outputs[0] is None:
            raise Exception("VibeVoice generated empty tensors")
            
        audio_np = outputs.speech_outputs[0].cpu().numpy().squeeze()
        wav_io = io.BytesIO()
        scipy.io.wavfile.write(wav_io, 24000, audio_np)
        
        return Response(content=wav_io.getvalue(), media_type="audio/wav")
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/v1/audio/transcriptions")
async def create_transcription(file: UploadFile = File(...), model: str = Form("whisper-1"), language: str = Form(None)):
    if not asr_model or not asr_processor:
        raise HTTPException(status_code=500, detail="VibeVoice ASR pipeline not loaded.")
    
    try:
        audio_bytes = await file.read()
        import tempfile
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
            
        try:
            inputs = asr_processor.apply_transcription_request(audio=tmp_path).to(asr_model.device, asr_model.dtype)
            output_ids = asr_model.generate(**inputs)
            generated_ids = output_ids[:, inputs["input_ids"].shape[1]:]
            transcription = asr_processor.decode(generated_ids, return_format="transcription_only")[0]
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
                
        return {"text": transcription}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False)
