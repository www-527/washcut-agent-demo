# 自动视频编排链路

## 范围与不变量

该链路位于现有应用中，但独立于旧营销视频的代理/转码管线。它的输入、状态和产物由以下不变量约束：

- 上传成功的原始文件保存为 data/auto-video/originals/<projectId>/<assetId>/original.<ext>，SQLite 会拒绝改变其哈希或路径的写入。
- 仅接受经过扩展名、声明 MIME、文件头和 ffprobe 校验的 MP4、WebM、MOV。当前 Remotion 环境不支持的编码会标记为 unsupported_asset，不会自动转码。
- 分析过程中只会创建临时 WAV（16 kHz、单声道）和 JPEG 截图。它们永不回写至原始视频，并在两条分析分支完成后删除。
- AI 输入分级：Speaches 只接收临时 WAV；视觉模型只接收单张 JPEG；综合理解和编排模型只接收规范化转写、截图结构化结果和媒体元数据。
- 每段素材在通过 EditPlan 校验后恰好进入一次时间线。Remotion 使用同一份时间线进行服务端渲染，不接收字幕数据。

## 处理顺序

~~~mermaid
flowchart LR
  A["多文件上传"] --> B["哈希、不可变保存、FFprobe"]
  B --> C["音频提取 → Speaches"]
  B --> D["首/中/尾及密度截图 → 视觉模型"]
  C --> E["素材综合理解"]
  D --> E
  E --> F["只决定顺序的 EditPlan"]
  F --> G["确定性帧时间线"]
  G --> H["Caption JSON"]
  H --> I["WebVTT"]
  G --> J["Remotion 无硬字幕 MP4"]
  I --> K["HTML5 预览的字幕轨"]
  J --> K
~~~

同一素材的转写与截图支路由 Promise.all() 并行；多个素材受 AUTO_VIDEO_ASSET_CONCURRENCY 限制。WebVTT 写入和 MP4 渲染也会并行。

Speaches 自身按 SPEACHES_MAX_RETRIES 重试；每张截图的视觉结构化分析还会按 AUTO_VIDEO_VISUAL_MAX_RETRIES 重试。失败会落在实际出错步骤，而不是笼统归因给同一项目中的其他并行步骤。

## API

所有项目 API 使用请求头中的现有租户/用户/角色认证上下文。前端开发默认使用 tenant_demo / user_demo / producer。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/projects | 创建项目和目标画布 |
| GET | /api/projects | 列出当前用户项目 |
| GET | /api/projects/:projectId | 项目、步骤、素材与已签名产物链接 |
| POST | /api/projects/:projectId/assets | 多文件上传，字段名 files |
| GET | /api/projects/:projectId/assets | 当前项目素材 |
| POST | /api/projects/:projectId/process | 仅入队，不同步等待 |
| POST | /api/projects/:projectId/retry | 从失败步骤重试 |
| GET | /api/projects/:projectId/progress | 项目和每步进度 |
| GET | /api/projects/:projectId/analysis | 转写、截图分析、素材理解 |
| GET | /api/projects/:projectId/edit-plan | 只读自动编排顺序 |
| GET | /api/projects/:projectId/timeline | 经过校验的帧时间线 |
| POST | /api/projects/:projectId/render | 使用已有时间线重新渲染 |
| GET | /api/render-jobs/:renderJobId | 渲染状态 |
| GET | /api/projects/:projectId/output | 已完成时返回 MP4/VTT 短时签名 URL |

原片、MP4 和 VTT 都经 HMAC 时效签名保护。项目本身仍会按租户和所有者过滤。

## 数据和清理策略

~~~text
data/auto-video/
├── originals/<project>/<asset>/original.{mp4,webm,mov}
├── temporary/<project>/<asset>/
└── projects/<project>/
    ├── transcription-<asset>.raw.json
    ├── edit-plan.json
    ├── timeline.json
    ├── captions.json
    ├── captions.vtt
    └── output.mp4
~~~

新渲染会先写入 output.next.mp4，仅在文件成功完成后替换当前 output.mp4；若替换失败，上一有效成片会恢复。渲染 props、失败临时 MP4、临时音频和截图会被清理，系统只保留一个当前成片。

## 生产配置与诊断

设置 DEMO_MODE=false 后，如果没有 SPEACHES_BASE_URL，项目会以 SPEACHES_UNAVAILABLE 失败，而不会静默伪造转写。Speaches 可用时请求：

~~~text
POST <SPEACHES_BASE_URL>/audio/transcriptions
file=<analysis.wav>
model=<SPEACHES_MODEL>
response_format=verbose_json
timestamp_granularities[]=segment
timestamp_granularities[]=word
temperature=0
language=zh
~~~

核心阶段、项目 ID、状态和进度输出为 JSON 日志；持久化的步骤记录包含 attempts、错误码和可读错误消息。常见错误码包括 INVALID_UPLOAD、UNSUPPORTED_ASSET、SPEACHES_UNAVAILABLE、INVALID_MODEL_RESPONSE、EDIT_PLAN_INVALID、TIMELINE_INVALID 和 RENDER_FAILED。

## 验证清单

1. 用至少两个短视频创建一个项目，确认 /assets 返回的哈希和元数据。
2. 验证原片哈希在处理前后相同，temporary 下分析文件在成功后已删除。
3. 观察转写/截图并行阶段，再检查 EditPlan 中每个素材只出现一次。
4. 确认 timeline.clips 无重叠或空洞、每段原始时长完整、volume=1、fit=contain。
5. 打开成品预览，切换字幕后确认网络面板没有新的处理请求；下载 MP4 与 VTT。
