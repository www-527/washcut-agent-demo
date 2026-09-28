# 自动视频编排链路

## 范围与不变量

该链路位于现有应用中，但独立于旧营销视频的代理/转码管线。它的输入、状态和产物由以下不变量约束：

- 上传成功的原始文件保存为 data/auto-video/originals/<projectId>/<assetId>/original.<ext>，SQLite 会拒绝改变其哈希或路径的写入。
- 仅接受经过扩展名、声明 MIME、文件头和 ffprobe 校验的 MP4、WebM、MOV。当前 Remotion 环境不支持的编码会标记为 unsupported_asset，不会自动转码。
- 分析过程中只会创建临时 WAV（16 kHz、单声道）和 JPEG 截图。它们永不回写至原始视频，并在两条分析分支完成后删除。
- AI 输入分级：Qwen3-ASR 与 ForcedAligner 只接收临时 WAV；视觉模型只接收本地生成的 JPEG 联系表或精查截图，并且只返回客观画面证据；整批角色判断只接收同一版本全部素材的规范化转写、客观画面字段、时长和用户要求，不接收原片、音频或本地路径；编排模型只接收已持久化的最终素材结论、时长和画布信息。
- 每段素材在通过 EditPlan 校验后恰好进入一次时间线。Remotion 使用同一份时间线进行服务端渲染，不接收字幕数据。

## 处理顺序

~~~mermaid
flowchart LR
  A["多文件上传"] --> B["哈希、不可变保存、FFprobe"]
  B --> C["音频提取 → Qwen3-ASR / ForcedAligner"]
  B --> D["首/中/尾及密度截图 → 视觉模型"]
  C --> E["等待整批 ASR 与画面分析完成"]
  D --> E
  E --> R["整批 MarketingRole 判断（一次调用）"]
  R --> U["持久化 AssetAnalysis + roleReason"]
  U --> F["口播叙事优先的 EditPlan"]
  F --> G["确定性帧时间线"]
  G --> H["Caption JSON"]
  H --> I["WebVTT"]
  G --> J["Remotion 无硬字幕 MP4"]
  I --> K["HTML5 预览的字幕轨"]
  J --> K
~~~

同一素材的转写与画面分析并行；多个素材受 `AUTO_VIDEO_ASSET_CONCURRENCY` 和所选视觉并发限制。所有有效素材完成后，`asset_understanding` 步骤构造 `auto-video-marketing-role-batch-input.v1`，仅调用一次整批角色判断操作；模型输出可在校验失败时携带具体错误受控修复，最多三轮。有效结果必须与当前版本素材 ID 集合完全一致、没有重复或未知 ID，九类角色合法且 `roleReason` 非空，随后立即写入生成版本。恢复时只有完整、合法、集合一致的结果才会复用，因此角色判断成功但编排未完成的任务不会重复调用角色模型。

最终 `marketingRole` 表示素材在广告中的主要叙事作用。有有效口播时以口播营销意图为主要依据，普通洗车动作差异可作为 B-roll；价格、优惠、门店、服务承诺或清洁效果的明确冲突必须写入判断及编排理由。视觉模型不再返回或决定最终角色。编排模型读取 `marketingRole`、`roleReason` 和 `audioSummary` 建立叙事结构，再用客观画面字段优化同类素材衔接；`finalClipOrder` 仍必须包含全部有效素材且每个恰好一次。

Qwen 网关调用按 `QWEN_ASR_MAX_RETRIES` 重试；每张截图的视觉结构化分析还会按 `AUTO_VIDEO_VISUAL_MAX_RETRIES` 重试。失败会落在实际出错步骤，而不是笼统归因给同一项目中的其他并行步骤。

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

创建生成版本前必须先启用 Qwen。应用启动器会在 Docker 引擎可用且前后端就绪后自动调用启用接口；失败时保留网关原始错误。Qwen 可用时依次请求：

~~~text
POST <QWEN_ASR_BASE_URL>/internal/asr/qwen3/transcribe
audio=<analysis.wav>
language=zh
model=<QWEN_ASR_MODEL>

POST <QWEN_ALIGN_BASE_URL>/internal/asr/qwen3/align
audio=<analysis.wav>
transcript=<上一步文本>
model=<QWEN_ALIGN_MODEL>
~~~

核心阶段、项目 ID、状态和进度输出为 JSON 日志；持久化的步骤记录包含 attempts、错误码和可读错误消息。常见错误码包括 INVALID_UPLOAD、UNSUPPORTED_ASSET、QWEN_ASR_UNREACHABLE、QWEN_ALIGN_INVALID_RESPONSE、INVALID_MODEL_RESPONSE、MARKETING_ROLE_ASSIGNMENT_INVALID、EDIT_PLAN_INVALID、TIMELINE_INVALID 和 RENDER_FAILED。整批角色模型的审计来源为 `auto-video.marketing-role-batch`；瞬态 Relay 错误保留原始 `code`、`message` 和可重试语义，并从 `asset_understanding` 断点恢复。三类 Worker 只在 API Server 成功取得监听端口后执行启动恢复；端口冲突进程不会领取任务。双成片与输出检查完成后显式完成 `render` 步骤，`completed` 生成的 progress 恒为 100，历史 91% 终态记录在启动迁移时规范化。

## 验证清单

1. 用至少两个短视频创建一个项目，确认 /assets 返回的哈希和元数据。
2. 验证原片哈希在处理前后相同，temporary 下分析文件在成功后已删除。
3. 观察转写/画面分析并行阶段，确认整批角色判断只在全部素材完成后执行；检查每条结论均有九类之一的 `marketingRole` 和非空 `roleReason`。
4. 检查模型对话中 `auto-video.marketing-role-batch` 的输入只包含当前版本全部素材且每个一次，不包含原片、音频、本地路径或旧视觉角色。
5. 确认 EditPlan 与 timeline.clips 使用全部素材各一次，无重叠或空洞、每段原始时长完整、volume=1、fit=contain。
6. 打开成品预览，切换字幕后确认网络面板没有新的处理请求；下载无字幕和带字幕 MP4 与 VTT。
