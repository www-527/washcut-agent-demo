from __future__ import annotations

import gc
import os
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

load_dotenv()

SERVICE_VERSION = "qwen3-asr-gateway-0.3.0"
ASR_MODEL_ID = os.getenv("QWEN_ASR_MODEL_ID", "Qwen/Qwen3-ASR-1.7B")
ALIGN_MODEL_ID = os.getenv("QWEN_ALIGN_MODEL_ID", "Qwen/Qwen3-ForcedAligner-0.6B")
ASR_MODEL_PATH = os.getenv("QWEN_ASR_MODEL_PATH", ASR_MODEL_ID)
ALIGN_MODEL_PATH = os.getenv("QWEN_ALIGN_MODEL_PATH", ALIGN_MODEL_ID)
API_KEY = os.getenv("QWEN_GATEWAY_API_KEY", "").strip()
MAX_UPLOAD_BYTES = int(os.getenv("QWEN_MAX_UPLOAD_BYTES", str(128 * 1024 * 1024)))
DEVICE_MAP = os.getenv("QWEN_DEVICE_MAP", "cuda:0").strip()
DTYPE_NAME = os.getenv("QWEN_DTYPE", "bfloat16").strip().lower()
MAX_INFERENCE_BATCH_SIZE = int(os.getenv("QWEN_MAX_INFERENCE_BATCH_SIZE", "1"))
MAX_NEW_TOKENS = int(os.getenv("QWEN_MAX_NEW_TOKENS", "256"))

CAR_WASH_AD_ZH_V2_TERMS = (
    "洗车",
    "精洗",
    "汽车美容",
    "外观清洗",
    "内饰清洁",
    "泡沫预洗",
    "高压水枪",
    "车身冲洗",
    "脚垫",
    "地毯",
    "座椅",
    "皮革座椅",
    "顶棚",
    "方向盘",
    "仪表台",
    "中控台",
    "出风口",
    "门把手",
    "车门饰板",
    "储物槽",
    "脚踏板",
    "后备箱",
    "细节刷",
    "软毛刷",
    "清洁剂",
    "内饰毛巾",
    "龙卷风清洁枪",
    "全车吸尘",
    "除尘",
    "除味",
    "轮胎",
    "轮毂",
    "轮胎上蜡",
    "轮胎保养",
    "打蜡",
    "抛光",
    "镀晶",
    "漆面",
    "格栅",
    "玻璃油膜",
    "水渍",
    "污渍",
    "洗车套餐",
    "到店",
    "下单",
    "团购",
    "优惠",
    "体验",
)

VOCABULARY_CONTEXTS = {
    # Historical generations used this profile when the gateway accepted the
    # field as metadata only. Keep it empty so retries remain reproducible.
    "car-wash-zh-v1": "",
    # Qwen's official API accepts short domain vocabulary through `context`.
    "car-wash-ad-zh-v2": " ".join(CAR_WASH_AD_ZH_V2_TERMS),
}

app = FastAPI(title="Qwen3 ASR private gateway", version=SERVICE_VERSION)
_model_lock = threading.Lock()
_shutdown_lock = threading.Lock()
_shutdown_started = False
_inference_lock = threading.Lock()
_asr_model: Any | None = None
_align_model: Any | None = None
_load_error: "GatewayError | None" = None


@dataclass
class GatewayError(Exception):
    code: str
    message: str
    retryable: bool
    details: str | None = None

    def payload(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details:
            result["details"] = self.details
        return result


def _error_response(error: GatewayError, status_code: int = 503) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": error.payload()})


def _check_api_key(authorization: str | None, x_api_key: str | None) -> None:
    if not API_KEY:
        return
    supplied = x_api_key or ""
    if not supplied and authorization and authorization.startswith("Bearer "):
        supplied = authorization.removeprefix("Bearer ").strip()
    if supplied != API_KEY:
        raise GatewayError("QWEN_GATEWAY_UNAUTHORIZED", "Qwen gateway API key is invalid.", False)


def _language(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    return {
        "zh": "Chinese",
        "zh-cn": "Chinese",
        "chinese": "Chinese",
        "en": "English",
        "english": "English",
        "ja": "Japanese",
        "japanese": "Japanese",
        "ko": "Korean",
        "korean": "Korean",
    }.get(normalized, value.strip() if value and value.strip() else None)


def _vocabulary_context(profile: str | None) -> tuple[str | None, str]:
    normalized = (profile or "").strip()
    if not normalized:
        return None, ""
    if normalized not in VOCABULARY_CONTEXTS:
        raise GatewayError(
            "QWEN_ASR_VOCABULARY_PROFILE_UNSUPPORTED",
            f"Unsupported vocabulary profile: {normalized!r}",
            False,
        )
    return normalized, VOCABULARY_CONTEXTS[normalized]


def _dtype(torch: Any) -> Any:
    if DTYPE_NAME in {"float16", "fp16", "half"}:
        return torch.float16
    if DTYPE_NAME in {"float32", "fp32"}:
        return torch.float32
    return torch.bfloat16


def _device_map() -> str | None:
    return DEVICE_MAP or None


def _load_models() -> tuple[Any, Any]:
    global _asr_model, _align_model, _load_error
    if _asr_model is not None and _align_model is not None:
        return _asr_model, _align_model
    with _model_lock:
        if _asr_model is not None and _align_model is not None:
            return _asr_model, _align_model
        try:
            import torch
            try:
                from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner
            except RuntimeError as exc:
                # qwen-asr imports nagisa eagerly. On some Windows DyNet wheels
                # nagisa cannot load its Japanese model even though this service
                # only accepts Chinese car-wash audio. Retry with the local
                # compatibility shim, without modifying site-packages.
                if "nagisa" not in str(exc).lower():
                    raise
                import sys
                from types import ModuleType, SimpleNamespace
                shim = ModuleType("nagisa")
                shim.tagging = lambda text: SimpleNamespace(words=list(text))
                sys.modules["nagisa"] = shim
                from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner

            common = {"dtype": _dtype(torch), "device_map": _device_map()}
            _asr_model = Qwen3ASRModel.from_pretrained(
                ASR_MODEL_PATH,
                max_inference_batch_size=MAX_INFERENCE_BATCH_SIZE,
                max_new_tokens=MAX_NEW_TOKENS,
                **common,
            )
            _align_model = Qwen3ForcedAligner.from_pretrained(ALIGN_MODEL_PATH, **common)
            _load_error = None
            return _asr_model, _align_model
        except Exception as exc:
            # Keep the original exception text for local diagnosis, but never
            # include credentials or audio bytes in the response.
            _load_error = GatewayError(
                "QWEN_MODEL_LOAD_FAILED",
                "Qwen ASR or forced-aligner model failed to load.",
                False,
                str(exc),
            )
            raise _load_error


def _models_ready() -> bool:
    return _asr_model is not None and _align_model is not None


def _gpu_memory_state() -> dict[str, int]:
    torch = sys.modules.get("torch")
    if torch is None or not torch.cuda.is_available():
        return {"allocatedBytes": 0, "reservedBytes": 0}
    torch.cuda.synchronize()
    return {
        "allocatedBytes": int(torch.cuda.memory_allocated()),
        "reservedBytes": int(torch.cuda.memory_reserved()),
    }


def _health_component(model_id: str, model_path: str, ready: bool) -> dict[str, Any]:
    result: dict[str, Any] = {
        "ready": ready,
        "model": model_id,
        "serviceVersion": SERVICE_VERSION,
    }
    if ready:
        result["modelPath"] = model_path
    elif _load_error is not None:
        result["error"] = _load_error.payload()
    return result


def _health_payload() -> dict[str, Any]:
    ready = _models_ready()
    return {
        "ready": ready,
        "asr": _health_component(ASR_MODEL_ID, ASR_MODEL_PATH, ready),
        "aligner": _health_component(ALIGN_MODEL_ID, ALIGN_MODEL_PATH, ready),
        "serviceVersion": SERVICE_VERSION,
        "gpuMemory": _gpu_memory_state(),
    }


def _require_models_loaded() -> tuple[Any, Any]:
    if not _models_ready():
        raise GatewayError(
            "QWEN_MODELS_NOT_LOADED",
            "Qwen models are not loaded. Activate Qwen before transcription.",
            False,
        )
    return _asr_model, _align_model


def _unload_models() -> dict[str, Any]:
    global _asr_model, _align_model, _load_error
    with _inference_lock:
        with _model_lock:
            asr_model = _asr_model
            align_model = _align_model
            _asr_model = None
            _align_model = None
            _load_error = None
        del asr_model, align_model
        gc.collect()
        torch = sys.modules.get("torch")
        if torch is not None and torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except RuntimeError:
                pass
        memory = _gpu_memory_state()
    return {
        "ready": False,
        "gpuMemoryReleased": memory["allocatedBytes"] == 0 and memory["reservedBytes"] == 0,
        "gpuMemory": memory,
        "serviceVersion": SERVICE_VERSION,
    }


def _exit_gateway_after_unload() -> None:
    # Give FastAPI enough time to flush the accepted response before stopping.
    time.sleep(0.5)
    try:
        _unload_models()
    finally:
        os._exit(0)


def _force_gateway_exit() -> None:
    # Inference is synchronous and may hold the unload lock. The gateway is
    # stateless, so a bounded process exit is the final GPU-release guarantee.
    time.sleep(15)
    os._exit(0)


def _read_upload(upload: UploadFile) -> bytes:
    data = upload.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise GatewayError(
            "QWEN_AUDIO_TOO_LARGE",
            f"Audio upload exceeds the {MAX_UPLOAD_BYTES} byte gateway limit.",
            False,
        )
    if not data:
        raise GatewayError("QWEN_AUDIO_EMPTY", "Audio upload is empty.", False)
    return data


def _with_audio_file(data: bytes, callback: Any) -> Any:
    # Windows does not permit the Qwen audio loader to reopen a still-open
    # NamedTemporaryFile. Close it before inference, then reliably remove it.
    temp = tempfile.NamedTemporaryFile(prefix="qwen-audio-", suffix=".wav", delete=False)
    temp_path = temp.name
    try:
        temp.write(data)
        temp.close()
        return callback(temp_path)
    finally:
        if not temp.closed:
            temp.close()
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass


def _as_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _result_field(result: Any, name: str, default: Any = None) -> Any:
    if isinstance(result, dict):
        return result.get(name, default)
    return getattr(result, name, default)


def _alignment_payload(results: Any) -> dict[str, Any]:
    if not isinstance(results, list) or len(results) != 1:
        raise GatewayError("QWEN_ALIGN_INVALID_RESULT", "Qwen forced aligner returned an invalid result.", False)
    result = results[0]
    # qwen-asr >= 0.0.6 returns one ForcedAlignResult per sample. The token
    # list lives in its `items` attribute; older adapters may return the list
    # directly, so retain that shape for compatibility.
    items = result if isinstance(result, list) else getattr(result, "items", None)
    if not isinstance(items, list):
        raise GatewayError("QWEN_ALIGN_INVALID_RESULT", "Qwen forced aligner returned an invalid item list.", False)
    if not items:
        return {
            "words": [],
            "segments": [],
            "alignmentModel": ALIGN_MODEL_ID,
            "serviceVersion": SERVICE_VERSION,
        }
    words: list[dict[str, Any]] = []
    for item in items:
        text = _as_text(_result_field(item, "text"))
        start = _result_field(item, "start_time")
        end = _result_field(item, "end_time")
        if not text or not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
            continue
        words.append({"text": text, "startMs": round(float(start) * 1000), "endMs": round(float(end) * 1000)})
    if not words:
        raise GatewayError("QWEN_ALIGN_TIMESTAMPS_MISSING", "Qwen forced aligner returned no valid timestamps.", False)
    return {
        "words": words,
        "segments": [{"text": "".join(item["text"] for item in words), "startMs": words[0]["startMs"], "endMs": words[-1]["endMs"]}],
        "alignmentModel": ALIGN_MODEL_ID,
        "serviceVersion": SERVICE_VERSION,
    }


@app.get("/internal/asr/qwen3/health", response_model=None)
def health(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any] | JSONResponse:
    try:
        _check_api_key(authorization, x_api_key)
        return _health_payload()
    except GatewayError as exc:
        return _error_response(exc, 401 if exc.code == "QWEN_GATEWAY_UNAUTHORIZED" else 503)


@app.post("/internal/asr/qwen3/load", response_model=None)
def load(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any] | JSONResponse:
    try:
        _check_api_key(authorization, x_api_key)
        _load_models()
        return _health_payload()
    except GatewayError as exc:
        return _error_response(exc, 401 if exc.code == "QWEN_GATEWAY_UNAUTHORIZED" else 503)


@app.post("/internal/asr/qwen3/unload", response_model=None)
def unload(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any] | JSONResponse:
    try:
        _check_api_key(authorization, x_api_key)
        return _unload_models()
    except GatewayError as exc:
        return _error_response(exc, 401 if exc.code == "QWEN_GATEWAY_UNAUTHORIZED" else 503)


@app.post("/internal/asr/qwen3/shutdown", response_model=None)
def shutdown(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any] | JSONResponse:
    global _shutdown_started
    try:
        _check_api_key(authorization, x_api_key)
        with _shutdown_lock:
            if not _shutdown_started:
                _shutdown_started = True
                threading.Thread(target=_exit_gateway_after_unload, daemon=True).start()
                threading.Thread(target=_force_gateway_exit, daemon=True).start()
        return {"accepted": True, "gatewayStopping": True, "serviceVersion": SERVICE_VERSION}
    except GatewayError as exc:
        return _error_response(exc, 401 if exc.code == "QWEN_GATEWAY_UNAUTHORIZED" else 503)


@app.post("/internal/asr/qwen3/transcribe", response_model=None)
def transcribe(
    audio: UploadFile = File(...),
    language: str | None = Form(default=None),
    model: str | None = Form(default=None),
    vocabularyProfile: str | None = Form(default=None),
    chunkingProfile: str | None = Form(default=None),
    requestId: str | None = Form(default=None),
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any] | JSONResponse:
    del chunkingProfile, requestId
    try:
        _check_api_key(authorization, x_api_key)
        if model != ASR_MODEL_ID:
            raise GatewayError("QWEN_ASR_MODEL_MISMATCH", f"Requested ASR model {model!r} does not match the configured model.", False)
        resolved_profile, context = _vocabulary_context(vocabularyProfile)
        data = _read_upload(audio)
        with _inference_lock:
            asr, _ = _require_models_loaded()
            result = _with_audio_file(
                data,
                lambda path: asr.transcribe(
                    audio=path,
                    context=context,
                    language=_language(language),
                    return_time_stamps=False,
                ),
            )
        if not isinstance(result, list) or len(result) != 1:
            raise GatewayError("QWEN_ASR_INVALID_RESULT", "Qwen ASR returned an invalid result.", False)
        item = result[0]
        text = _as_text(_result_field(item, "text"))
        return {
            "text": text,
            "language": _result_field(item, "language"),
            "detectedLanguage": _result_field(item, "language"),
            "model": ASR_MODEL_ID,
            "vocabularyProfile": resolved_profile,
            "contextApplied": bool(context),
            "serviceVersion": SERVICE_VERSION,
        }
    except GatewayError as exc:
        return _error_response(exc, 401 if exc.code == "QWEN_GATEWAY_UNAUTHORIZED" else 503)
    except Exception as exc:
        return _error_response(GatewayError("QWEN_ASR_INFERENCE_FAILED", "Qwen ASR inference failed.", True, str(exc)))


@app.post("/internal/asr/qwen3/align", response_model=None)
def align(
    audio: UploadFile = File(...),
    transcript: str = Form(...),
    language: str | None = Form(default=None),
    model: str | None = Form(default=None),
    requestId: str | None = Form(default=None),
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> dict[str, Any] | JSONResponse:
    del requestId
    try:
        _check_api_key(authorization, x_api_key)
        if model != ALIGN_MODEL_ID:
            raise GatewayError("QWEN_ALIGN_MODEL_MISMATCH", f"Requested aligner model {model!r} does not match the configured model.", False)
        if not transcript.strip():
            return {
                "words": [],
                "segments": [],
                "alignmentModel": ALIGN_MODEL_ID,
                "serviceVersion": SERVICE_VERSION,
            }
        data = _read_upload(audio)
        with _inference_lock:
            _, aligner = _require_models_loaded()
            results = _with_audio_file(data, lambda path: aligner.align(audio=path, text=transcript, language=_language(language)))
        return _alignment_payload(results)
    except GatewayError as exc:
        return _error_response(exc, 401 if exc.code == "QWEN_GATEWAY_UNAUTHORIZED" else 503)
    except Exception as exc:
        return _error_response(GatewayError("QWEN_ALIGN_INFERENCE_FAILED", "Qwen forced alignment failed.", True, str(exc)))


