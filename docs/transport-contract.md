# 统一传输合同 v1

本项目所有业务 API、Agent Worker、媒体 Worker、任务事件和 Remotion 输入均使用 UTF-8 JSON Envelope。媒体二进制本身不进入 JSON；上传接口接收 multipart 二进制，成功后只返回 `AssetRef`。

## Envelope

```json
{
  "version": "1.0",
  "type": "video-spec.created",
  "eventId": "evt_<uuid>",
  "occurredAt": "2026-08-12T00:00:00.000Z",
  "traceId": "trc_<uuid>",
  "causationId": "evt_<upstream-uuid>",
  "tenantId": "tenant_demo",
  "projectId": "project_<uuid>",
  "jobId": "job_<uuid>",
  "producer": "visual-director-agent",
  "idempotencyKey": "job_<uuid>:video-spec.created:video-spec.v1",
  "payload": {
    "schema": "video-spec.v1",
    "data": {}
  }
}
```

外层只承载传输、追踪和幂等元数据；`payload.data` 只包含对应业务对象。生产者和消费者都必须通过 Envelope Schema 与已注册 Payload Schema 两层校验。

## 命名和单位

- 消息类型：英文小写 `对象.动作`，多词使用连字符。
- Schema：独立版本，例如 `asset-manifest.v1`。
- 时间：ISO 8601 UTC。
- 时长：统一使用整数 `durationMs`。
- 金额：当前优惠使用用户确认的精确字符串；增加结构化金额时必须使用整数分。
- ID：带语义前缀的 UUID，例如 `job_<uuid>`。
- 枚举：英文机器码。

## 已注册 Payload Schema

- `project-input.v1`
- `asset-upload-request.v1`
- `asset-batch.v1`
- `asset-manifest.v1`
- `creative-direction-request.v1`
- `creative-spec.v1`
- `visual-direction-request.v1`
- `video-spec.v1`
- `quality-check-request.v1`
- `quality-report.v1`
- `render-job.v1`
- `command-result.v1`
- `event-batch.v1`
- `health-status.v1`
- `error.v1`

注册表的实现位于 `src/shared/contracts.ts`。未知 Schema、未知字段、错误类型或旧字段（如 `durationSec`）会被拒绝。

## 消息语义

命令表示请求工作：

- `render-job.create-requested`
- `asset-analysis.requested`
- `render.requested`
- `quality-check.requested`

事件表示已经发生：

- `asset-manifest.created`
- `creative-spec.created`
- `video-spec.created`
- `quality-check.completed`
- `quality-check.failed`
- `render.failed`
- `render-job.cancelled`

API 结果表示请求结果：

- `asset-upload.completed`
- `render-job.accepted`
- `render-job.fetched`
- `render-job.cancel-accepted`
- `event-batch.fetched`
- `health.checked`
- `request.failed`

## 错误结构

所有错误通过 `request.failed`、`render.failed` 或 `quality-check.failed` 携带 `error.v1`：

```json
{
  "code": "invalid_transport_message",
  "stage": "business_api",
  "retryable": false,
  "message": "请求消息未通过校验。",
  "details": {}
}
```

`details` 不得包含 API Key、Bearer Token、Cookie、图片 data URL、媒体二进制或加密推理内容。

## 幂等与因果链

- 产生副作用的命令必须包含稳定 `idempotencyKey`。
- `POST /api/jobs` 对相同幂等键返回第一次创建的同一个接受结果，不会创建第二个任务。
- 每个阶段消息的 `causationId` 指向直接上游 `eventId`。
- `/api/jobs/:jobId/events` 返回完整审计链，前端结果页可展开 `Transport Envelopes` 检查。

## Remotion 边界

Remotion Composition 不再直接接收裸 `VideoSpec`。唯一输入是：

- `type: render.requested`
- `payload.schema: video-spec.v1`
- `payload.data: VideoSpec`

Composition 启动和元数据计算前会再次执行运行时 Schema 校验。
