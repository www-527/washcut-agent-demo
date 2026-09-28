# 口播优先整批 MarketingRole 判断：实施与回归报告

> 实施与回归日期：2026-09-01  
> 对应方案：《口播优先整批 MarketingRole 判断：AI 实施方案》  
> 结论：方案已实施；自动化测试、生产构建和 11 段真实主包完整链路均通过。

## 1. 实施范围与结果

本次改动把 `marketingRole` 的最终决定权从“逐段画面分析”移动到“同一生成版本全部 ASR 与客观画面证据完成后的整批判断”。新流程满足以下不变量：

- 视觉模型只返回客观画面证据，不再决定最终广告作用。
- 整批输入只包含素材 ID、口播、客观画面摘要、动作、场景、屏幕文字、画面顺序、时长和用户指令，不包含原始路径、临时音频路径或旧角色结论。
- 每个新生成版本只建立一次 `auto-video.marketing-role-batch` 模型操作；只有结构或语义校验失败时，才在同一操作中执行最多三轮受控修复。
- 输出必须与输入素材 ID 集合完全相等，每个 ID 恰好一次，角色属于九类枚举，`roleReason` 非空。
- 合法结果在进入全量编排前立即写入 checkpoint；失败从 `asset_understanding` 阶段恢复。
- 历史 checkpoint 仍可读取；新链路复用分析时要求精确 ID 集合和完整 `roleReason`，不会把“数量相同但素材不同”的结果当作有效缓存。

涉及代码：

- `src/shared/auto-video-contracts.ts`：版本化整批输入/输出合同、历史视觉结果兼容和 `asset_understanding` 重试阶段。
- `src/server/auto-video-ai.ts`：客观视觉提示词、整批角色提示词、严格输出校验、受控修复、口播优先的编排提示词。
- `src/server/auto-video-worker.ts`：整批屏障、模型并发控制、立即持久化、精确集合恢复和错误阶段映射。
- `src/server/auto-video.test.ts`：合同、校验、修复、历史兼容、恢复和提示词回归。

## 2. 自动化验证

在最终代码上执行：

| 验证 | 结果 |
| --- | --- |
| `pnpm test` | 通过，90/90（含后续端口所有权与终态进度回归） |
| `pnpm build` | 通过；TypeScript project build 与 Vite production build 均成功 |
| 整批输出集合校验 | 覆盖缺失、重复、未知 ID、非法角色、空理由及乱序合法输出 |
| 修复上限 | 覆盖具体错误进入下一轮提示词，以及三次无效响应后停止 |
| 历史兼容 | 历史 `assetAnalysis` 可读；旧视觉结果中的 `marketingRole` 和 `suggestedPosition` 被兼容层剥离 |
| 恢复语义 | 覆盖精确 ID 集合复用、错误集合拒绝和历史无 `roleReason` 不进入新链路复用 |
| 提示词边界 | 覆盖视觉提示词无角色判断、整批输入无文件路径、编排口播优先 |

## 3. 真实主包回归

### 3.1 测试对象

- 项目：`project_9e34e8c8-f770-43f5-862c-8a47b73dbc54`（名称：测试）
- 有效生成版本：`generation_f0e85514-c81c-4575-bbcb-2a314e6eed64`（V3）
- 用户指令：`请依据内容自然衔接全部素材，优先保持叙事时间顺序。`
- 模型：`gpt-5.6-terra`，reasoning `medium`
- ASR：Qwen3-ASR
- 输入：11 段主包素材，上传顺序被打乱
- 完成时间：2026-09-01 17:32:36（Asia/Shanghai）

### 3.2 整批角色操作审计

- 对话 ID：`mdl_e329bac0-1eae-4792-b722-997ac9d449fd`
- 来源：`auto-video.marketing-role-batch`
- 同一生成版本、同一来源的模型操作数：1
- 尝试次数：1
- 延迟：33464 ms
- 输入 Schema：`auto-video-marketing-role-batch-input.v1`
- 输入素材数：11；唯一素材 ID 数：11
- 11 段均包含口播和客观画面摘要。
- 结构化输入未发现 `originalPath`、临时音频路径、Windows 文件路径、`file://`、`.mp4` 或逐段视觉阶段遗留的 `marketingRole`。
- 输出包含 11 个且仅包含这 11 个素材 ID；每项均有合法角色和非空 `roleReason`。

### 3.3 角色判断结果

| 原素材 | 最终角色 | 结果 |
| --- | --- | --- |
| `wc-main-01-hook.mp4` | `hook` | 符合预期 |
| `wc-main-02-problem.mp4` | `problem` | 符合预期 |
| `wc-main-03-service.mp4` | `service` | 符合预期 |
| `wc-main-04-foam.mp4` | `process` | 符合预期 |
| `wc-main-05-rinse.mp4` | `process` | 符合预期 |
| `wc-main-06-wheel.mp4` | `detail` | 符合预期 |
| `wc-main-07-interior.mp4` | `detail` | 符合预期 |
| `wc-main-08-result.mp4` | `result` | 符合预期 |
| `wc-main-09-transition.mp4` | `transition` | 符合预期 |
| `wc-main-10-offer.mp4` | `offer` | 符合预期 |
| `wc-main-11-cta.mp4` | `cta` | 符合预期 |

这组结果修复了旧链路中 Hook、Result、Offer 和 CTA 因画面出现洗车动作而被覆盖为 `process/transition` 的核心偏差。

### 3.4 最终编排与成片

最终时间线顺序为：

1. `wc-main-01-hook.mp4`
2. `wc-main-02-problem.mp4`
3. `wc-main-03-service.mp4`
4. `wc-main-04-foam.mp4`
5. `wc-main-05-rinse.mp4`
6. `wc-main-06-wheel.mp4`
7. `wc-main-07-interior.mp4`
8. `wc-main-09-transition.mp4`
9. `wc-main-08-result.mp4`
10. `wc-main-10-offer.mp4`
11. `wc-main-11-cta.mp4`

集合检查结果：11 个素材全部使用，唯一素材数 11，未删除、未遗漏、未重复；`excludedAssetIds` 为空。角色结果在 planning 运行前已作为 11 条完整 `assetAnalyses` 持久化。

成片检查：

- 普通版和字幕版均为 `ready`，字幕与 inspection 均为 `ready`。
- 元数据时长 52800 ms；`ffprobe` 实测 52.842667 秒。
- 1080×1920、30 fps、H.264 视频、AAC 音频。
- 普通版大小 59,990,838 字节；字幕版大小 59,920,223 字节。
- 使用完整 FFmpeg 分别对普通版和字幕版执行全量解码，两个命令均以退出码 0 完成且无解码错误。

## 4. 回归过程中的异常与处置

为保留真实证据，本节记录两次测试环境事件；它们不计为业务链路通过项，也未被静默忽略。

1. V2 `generation_d5953048-78eb-43e8-9259-3a3f695d7889` 的 PowerShell 请求体发生中文编码替换，指令被写成问号。该版本立即取消并保留，没有删除或冒充有效回归。
2. V3 首次运行期间，模型服务激活进程退出，Qwen 转写按原始 `QWEN_ASR_TRANSCRIBE_FAILED`、`retryable: true`、`stage: transcription` 暴露。随后临时服务与开发 watcher 同时启动了 Worker；乐观 checkpoint 锁拒绝陈旧写入并返回 `checkpoint_concurrent_update`，避免覆盖较新的 checkpoint。停止重复后端、恢复单实例并重新激活 Qwen 后，V3 从已保存 checkpoint 继续并完成。

第二项暴露了一个与 MarketingRole 方案无关但真实存在的启动顺序风险。该问题已在同日后续修复：API Server 在调用 `listen` 前注册恢复边界，只有当前进程实际收到 `listening` 事件后才启动 Worker recovery；端口绑定失败会记录原始 `code/message/retryable`、关闭 SQLite，且不会执行任何恢复任务。新增回归分别验证端口被占用时恢复次数为 0，以及成功监听时每个 Worker 只恢复一次。现有 checkpoint 乐观并发控制继续保留，未被削弱。

终态输出全部就绪时聚合 progress 显示 91 的问题也已在同日后续修复：输出检查成功后显式完成 `render` 步骤；保存函数在写入 `status: completed` 时固定计算为 progress 100；专用启动迁移只把已存在的 completed 91% 快照规范化为 100，并保留转写、分析、编排、时间线和产物字段。活动状态仍按各步骤真实进度计算，不会被提前抬到 100。

修复验证期间，初版曾把终态进度约束放进通用生成 Schema，使 V3 误入项目既有的畸形快照兜底路径。发现后已立即撤销该过强门禁，改为上述专用非破坏迁移，并从未受影响的 11 份 checkpoint、模型对话审计、`edit-plan.json`、`timeline.json` 和两份成片恢复 V3 快照。最终复核结果为 connected 模式、progress 100、十个步骤全部 completed、11 份转写、11 份含角色理由的分析、11 段时间线以及普通/字幕双产物全部 ready。恢复前数据库证据保留在 `data/washcut.before-v3-restore-20260901.sqlite`，没有删除用户原片、对话、checkpoint 或成片。

## 5. 验收结论

- [x] 逐段视觉分析不再决定最终 `marketingRole`。
- [x] 全部 ASR 与客观画面证据完成后执行整批角色判断。
- [x] 输入 N=11 时，角色输出和 `finalClipOrder` 均包含且仅包含 11 个原始素材 ID，每个恰好一次。
- [x] 每段都有可读内容说明、合法广告作用和非空判断理由。
- [x] 编排以口播叙事为主，画面信息用于衔接和辅助判断。
- [x] 字幕、时间线、普通版和字幕版成片均从原始片段完成导出。
- [x] 批量失败保留原始错误；恢复与历史兼容行为有自动化覆盖。

本实施方案的代码与主包验收已完成。回归中发现的运行时启动顺序和终态进度问题也已修复，并通过完整 `pnpm test` 90 项与生产构建验证；当前没有由本报告保留的阻塞项。
