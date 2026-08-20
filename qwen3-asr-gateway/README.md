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
snapshots. The existing `D:\短视频\model` directory is a Whisper large-v3
snapshot, not a Qwen snapshot, and must not be moved or overwritten.

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
Keep this lightweight gateway process running while using the app. Health is
passive and never loads either model. Clicking **启用** for Qwen calls `load`;
switching away calls `unload`, waits for active inference to finish, drops both
model references, runs Python garbage collection and clears the CUDA cache.

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
- The `vocabularyProfile` and `chunkingProfile` fields are accepted as
  versioned request metadata. They are not silently treated as custom model
  prompts; custom vocabulary behavior must be added only after a real Qwen
  evaluation proves it.

The implementation follows the official Qwen3-ASR examples in the upstream
repository, including `Qwen3ASRModel.from_pretrained`,
`Qwen3ForcedAligner.from_pretrained`, `transcribe`, and `align`.
