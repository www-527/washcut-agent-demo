# Qwen3-ASR private gateway

This service is a local-only FastAPI adapter for the main Washcut app. It loads
`Qwen/Qwen3-ASR-1.7B` and `Qwen/Qwen3-ForcedAligner-0.6B` through the official
`qwen-asr` Python package and exposes the internal contract consumed by the
TypeScript app:

- `GET /internal/asr/qwen3/health`
- `POST /internal/asr/qwen3/load`
- `POST /internal/asr/qwen3/unload`
- `POST /internal/asr/qwen3/transcribe`
- `POST /internal/asr/qwen3/align`

The service binds to `127.0.0.1` by default. Do not expose it to the public
internet. If `QWEN_GATEWAY_API_KEY` is set, the app sends it as a Bearer token.
The gateway never logs audio bytes, transcript contents, or API keys.

## Models

The ASR and forced-aligner models must be two independent, complete model
snapshots under `D:\短视频\model`.

Set `QWEN_ASR_MODEL_PATH` and `QWEN_ALIGN_MODEL_PATH` to the actual local
snapshot directories. The model IDs reported by health must remain the exact
IDs configured in the main app.

## Install and run

```powershell
cd D:\短视频\washcut-agent-demo\qwen3-asr-gateway
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env for your local snapshot paths and CUDA device.
python -m uvicorn app:app --host 127.0.0.1 --port 8010
```

For GPU inference, install a PyTorch build matching the installed CUDA driver
before installing `qwen-asr` if the package does not install the desired build.
The main app can start this local gateway on demand when the Qwen **启动网关**
button is clicked. On Windows, if the restricted app process cannot load
PyTorch (`WinError 5`), the app invokes `start-qwen-gateway.ps1`, which asks for
UAC approval and starts the gateway in an administrator process. Health is
passive and never loads either model. After the gateway becomes reachable, the app calls `load`; switching away calls `unload`,
waits for active inference to finish, drops both model references, runs Python
garbage collection and clears the CUDA cache. Manual startup with the command
above remains supported.

## Contract notes

- Non-empty ASR text is aligned by `Qwen3-ForcedAligner-0.6B`; timestamps are
  returned in milliseconds as `words[].startMs` / `words[].endMs`.
- The gateway rejects an alignment response with no valid timestamps; it never
  estimates timestamps from text length.
- Model mismatch, unauthorized access, upload limits, and load/inference
  failures return `{ "error": { "code", "message", "retryable" } }`.
- Transcribe and align reject requests until `load` succeeds. `unload` returns
  `gpuMemoryReleased` plus the process CUDA allocated/reserved byte counts; the
  main app will not activate another model unless release is confirmed.
- `car-wash-zh-v1` is the historical no-context vocabulary profile. New
  generations use `car-wash-ad-zh-v2`, a server-owned list of common car-wash
  service, construction, detailing, result, and conversion terms. The gateway
  passes its short, space-separated text to the official
  `Qwen3ASRModel.transcribe(context=...)` argument. Unknown non-empty profiles
  fail with `QWEN_ASR_VOCABULARY_PROFILE_UNSUPPORTED`; browsers cannot provide
  arbitrary prompts.
- Vocabulary profile names are immutable. Add a new version when changing the
  term set so historical generation retries keep their original behavior.
- `context` biases recognition but is not a forced dictionary. Keep terms
  short and evaluate real positive and negative audio because excessive context
  can leak into transcription output.

The implementation follows the official Qwen3-ASR examples in the upstream
repository, including `Qwen3ASRModel.from_pretrained`,
`Qwen3ForcedAligner.from_pretrained`, `transcribe`, and `align`.
