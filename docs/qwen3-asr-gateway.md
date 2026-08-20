# Qwen3-ASR 私有网关部署与模型目录

> 本文定义主应用与 Qwen 网关之间的私有 HTTP 合同；主 Node 应用**不直接加载**本地模型文件。

## 1. 先整理当前下载的模型

当前 `D:\短视频\model` 不应同时作为 Whisper（CTranslate2）与两个 Qwen 模型的目录。Qwen 模型除 `.safetensors` 权重外还需要对应仓库中的 `config.json`、tokenizer / processor 文件，以及多分片模型的索引文件。请保留原文件，不要覆盖；在补齐模型文件后整理为：

```text
D:\短视频\models\
  qwen3-asr-1.7b\                 # Qwen/Qwen3-ASR-1.7B 的完整仓库快照
    config.json
    model.safetensors.index.json   # 多分片时必须存在
    model-00001-of-00002.safetensors
    model-00002-of-00002.safetensors
    ... tokenizer / processor 等其余文件
  qwen3-forced-aligner-0.6b\      # Qwen/Qwen3-ForcedAligner-0.6B 的完整仓库快照
    config.json
    model.safetensors
    ... tokenizer / processor 等其余文件
  whisper-large-v3-ctranslate2\   # 原 Speaches / faster-whisper 文件，保持独立
```

官方模型页：

- [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)
- [Qwen3-ForcedAligner-0.6B](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B)
- [Qwen3-ASR 官方运行说明](https://github.com/QwenLM/Qwen3-ASR)

若使用 Hugging Face CLI 下载完整快照，示例（根据实际磁盘路径调整）：

```powershell
huggingface-cli download Qwen/Qwen3-ASR-1.7B --local-dir D:\短视频\models\qwen3-asr-1.7b
huggingface-cli download Qwen/Qwen3-ForcedAligner-0.6B --local-dir D:\短视频\models\qwen3-forced-aligner-0.6b
```

不要只下载大权重文件；缺失的配置、tokenizer、processor 或索引会让服务无法可靠载入模型。

## 2. 私有网关合同

网关仅绑定到本机或受信内网，例如 `127.0.0.1:8010`；不开放给浏览器或公网。主应用通过以下环境变量访问：

```env
QWEN_ASR_BASE_URL=http://127.0.0.1:8010
QWEN_ALIGN_BASE_URL=                 # 空时与 ASR 使用同一个网关
QWEN_ASR_API_KEY=
QWEN_ASR_MODEL=Qwen/Qwen3-ASR-1.7B
QWEN_ALIGN_MODEL=Qwen/Qwen3-ForcedAligner-0.6B
QWEN_ASR_TIMEOUT_MS=600000
QWEN_ASR_MAX_RETRIES=2
```

### 健康检查

`GET /internal/asr/qwen3/health`

```json
{
  "asr": {"ready": true, "model": "Qwen/Qwen3-ASR-1.7B", "serviceVersion": "gateway-1.0.0"},
  "aligner": {"ready": true, "model": "Qwen/Qwen3-ForcedAligner-0.6B", "serviceVersion": "gateway-1.0.0"}
}
```

ASR、对齐器都必须是 `ready: true` 且模型名与配置精确一致，网页才会启用 Qwen 选项。

### 转写

`POST /internal/asr/qwen3/transcribe`，`multipart/form-data`：`audio`（mono / 16 kHz PCM WAV）、`language=zh`、`model`、`vocabularyProfile=car-wash-zh-v1`、`chunkingProfile=vad-overlap-30s-v1`、`requestId`。

成功响应至少包含：

```json
{"text":"精洗套餐今天优惠","language":"zh","serviceVersion":"gateway-1.0.0"}
```

网关负责 VAD 分片与重叠合并，不能在边界重复或遗漏词。

### 强制对齐

`POST /internal/asr/qwen3/align`，`multipart/form-data`：`audio`、`transcript`、`language=zh`、`model`、`requestId`。

成功响应必须提供真实毫秒时间戳：

```json
{
  "words": [{"word":"精洗","startMs":0,"endMs":240,"confidence":0.98}],
  "segments": [{"text":"精洗套餐今天优惠","startMs":0,"endMs":1000,"confidence":0.97}],
  "alignmentModel":"Qwen/Qwen3-ForcedAligner-0.6B",
  "serviceVersion":"gateway-1.0.0"
}
```

对于非空文本，词级和片段级时间戳都缺失或无效即视为失败；主应用不会生成估算时间戳，更不会回退到 Whisper。

### 错误格式

上游错误必须原样提供：

```json
{"error":{"code":"ALIGNER_BUSY","message":"aligner queue is full","retryable":true}}
```

主应用将保留该 `code`、`message` 与 `retryable`，用于页面、重试和审计。

## 3. 验收步骤

1. 启动网关，并确认 health 响应中两个模型均就绪。
2. 在 `.env` 填写 Qwen 环境变量后启动应用。
3. 打开“创建智能编排版本”，确认 Qwen 按钮可选；未就绪时应显示网关原始错误。
4. 用一段有口播的洗车素材创建 Qwen 版本，检查版本详情中的锁定快照、原始转写工件、字幕与时间轴。
5. 再以 Whisper 创建新版本进行人工 A/B 对比。Qwen 未完成真实洗车素材评测前仍保持 Whisper 为默认。
