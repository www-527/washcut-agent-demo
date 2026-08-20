# 视频上传与 AI 分析 API v1

本接口在现有洗车片场出片链路之外提供独立的视频接入与分析能力，覆盖小文件直传、大文件分片续传、受控 HTTPS URL 导入、异步任务、取消/重试、统一结果和 Webhook。

所有业务响应继续使用项目统一的 UTF-8 JSON Envelope。示例中的实际数据位于 `payload.data`。

## 请求身份

每个请求至少携带以下 Header：

```http
X-Tenant-Id: tenant_demo
X-User-Id: user_demo
X-Role: producer
X-Project-Id: project_<uuid>
X-Job-Id: job_<uuid>
X-Trace-Id: trace_<uuid>
```

`viewer` 只能读取自己有权访问的任务；`producer` 和 `admin` 可以创建、取消和重试。资源始终按 tenant、owner 和 project 进行服务端校验。

## 1. 小视频直传

```http
POST /api/v1/video/analyze
Content-Type: multipart/form-data
X-Idempotency-Key: upload-request-001
X-File-Sha256: <可选的整文件 SHA-256>
```

表单字段：

- `file`：MP4 或 WebM；默认单文件上限 250 MiB。
- `prompt`：分析目标，默认“提取字幕，并按时间轴总结关键动作”。
- `language`：默认 `zh-CN`。
- `callback_url`：可选，必须是解析到公网地址的 HTTPS URL。

接口完成上传、magic byte、SHA-256、媒体流和分辨率检查后返回 `202` 与 `task_id`；分析继续在后台 Worker 中执行。同一个幂等键会返回原任务，不会重复创建任务。

## 2. 大文件分片与断点续传

### 创建会话

```http
POST /api/v1/video/uploads
Content-Type: application/json

{
  "filename": "meeting.mp4",
  "mime_type": "video/mp4",
  "size_bytes": 536870912,
  "sha256": "<64位十六进制整文件 SHA-256>",
  "prompt": "提取字幕并生成会议纪要",
  "language": "zh-CN",
  "idempotency_key": "meeting-upload-001"
}
```

返回 `upload_id`、`part_size_bytes`（默认 8 MiB）、`total_parts`、`expires_at`、`completed_part_numbers` 和本机上传地址模板。

### 上传分片

```http
PUT /api/v1/video/uploads/{upload_id}/parts/{part_number}
Content-Type: application/octet-stream
Content-Range: bytes 0-8388607/536870912
X-Part-Sha256: <当前分片 SHA-256>

<分片二进制>
```

服务端严格校验分片编号、Range、长度和摘要。重复 PUT 同一分片是安全的；客户端可通过 `GET /api/v1/video/uploads/{upload_id}` 获取已完成编号，并且只续传缺失分片。

### 完成上传

```http
POST /api/v1/video/uploads/{upload_id}/complete
```

只有全部分片到齐时才接受完成请求。接口立即返回分析任务；Worker 顺序组装分片，再次校验整文件大小与 SHA-256，然后进入媒体处理和分析。成功后会清理该会话的分片文件。

## 3. HTTPS URL 导入

```http
POST /api/v1/video/analyze-url
Content-Type: application/json

{
  "video_url": "https://storage.example.com/video.mp4?signature=...",
  "prompt": "定位车辆进入画面的时间",
  "language": "zh-CN",
  "sha256": "<可选的整文件 SHA-256>",
  "idempotency_key": "remote-video-001"
}
```

URL 必须使用 HTTPS，不能携带用户凭据，不能使用非 443 端口，且 DNS 解析结果不得包含 loopback、私网、链路本地、保留或组播地址。每次重定向都会重新执行同样的检查，最多跟随 3 次；响应类型仅接受 MP4/WebM，默认下载上限 250 MiB。

## 4. 查询、取消与重试

```http
GET  /api/v1/video/tasks/{task_id}
POST /api/v1/video/tasks/{task_id}/cancel
POST /api/v1/video/tasks/{task_id}/retry
```

查询结果包含：

- `status`：`queued | processing | completed | failed | cancelled`。
- `progress`：0–100。
- `current_stage`：校验、元数据、转写、画面分析、合并等当前阶段。
- `error`：稳定错误码、失败阶段、是否可重试、可读消息和诊断详情。
- `result`：完成后的统一分析结果。

Worker 在进程启动时恢复未完成任务。取消会写入持久化标记并中断当前媒体/网络操作；只有 `failed` 且标记为可重试的任务才能进入重试。

## 5. 统一结果

```json
{
  "summary": "视频展示车辆进入服务区。",
  "transcript": [
    {"start": 2.4, "end": 6.8, "text": "欢迎来到今天的活动现场。"}
  ],
  "timeline": [
    {"start": 0, "end": 4.2, "description": "车辆驶入画面", "tags": ["vehicle", "driving"]}
  ],
  "entities": [
    {"type": "vehicle", "label": "白色轿车", "appearances": [{"start": 0, "end": 9.8}]}
  ],
  "metadata": {
    "duration_seconds": 42.5,
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "has_audio": true,
    "source_sha256": "...",
    "model_version": "...",
    "prompt": "定位车辆进入画面的时间",
    "language": "zh-CN",
    "warnings": []
  }
}
```

媒体尺寸、时长、帧率、音轨和 SHA-256 一律来自服务端探测，模型不能覆盖。Relay 模式把私有关键帧字节发送给已启用的视觉模型并校验返回 Schema 与时间边界；本地模式只输出确定性的媒体/关键帧时间轴，不臆测画面内容。

当前项目没有内置通用 ASR 服务：未配置语音识别时 `transcript` 返回空数组，并在 `metadata.warnings` 明确说明。生产环境应接入有授权的中文 ASR/词级对齐适配器后再将其作为字幕能力验收。

## 6. Webhook

任务结束后向 `callback_url` 发送：

```http
POST <callback_url>
Content-Type: application/json
X-Signature: <HMAC-SHA256(body)>
X-Event-Id: evt_<uuid>
```

```json
{
  "event": "video.analysis.completed",
  "event_id": "evt_...",
  "task_id": "task_vid_...",
  "status": "completed",
  "result_url": "https://api.example.com/api/v1/video/tasks/task_vid_..."
}
```

非 2xx 响应按 1、5、30 分钟退避重试。每次尝试写入 `webhook_deliveries`；接收方应按 `event_id` 幂等处理。签名密钥使用 `WEBHOOK_SIGNING_SECRET`，未配置时回退到 `MEDIA_SIGNING_SECRET`。

## 7. 运维指标

管理员访问 `/api/metrics` 可获得原有任务指标以及：

- `washcut_video_analysis_tasks_total{status=...}`
- `washcut_video_upload_sessions_total`
- `washcut_webhook_deliveries_total`

建议同时监控 API 5xx、上传校验失败、队列积压、任务阶段耗时、URL 导入拒绝率和 Webhook 最终失败率。
