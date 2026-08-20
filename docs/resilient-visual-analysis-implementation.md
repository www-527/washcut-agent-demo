# 断点恢复、持续重试与可中断视觉理解：AI 实施规格

> 文档版本：v1.0  
> 面向对象：负责 TypeScript、SQLite、Express Worker、Relay 调用、React 界面和自动化测试的 AI 编码代理  
> 实施状态：待实施  
> 关联文档：[自适应视觉理解与快速编排：AI 实施规格](adaptive-visual-analysis-implementation.md)

## 1. 目标、问题与边界

当前的平衡理解模式以项目内全部素材为一批执行音频、截图和视觉理解。当其中一条素材的上游视觉请求失败时，生成版本会标记为失败。用户点击“从失败步骤重试”后，已完成的项目级步骤会保留，但视觉理解的成功结果只在整批素材都成功后统一保存。因此，已成功理解的第一条素材可能再次发送给模型。

本实施必须改为以下行为：

1. 每条素材的画面理解成功后立即持久化为该生成版本的检查点。
2. 临时上游错误自动持续重试，直至成功、用户中断，或错误被判定为不可恢复。
3. 重试时只处理未完成或失败的素材；不得重复调用已经完成画面理解的素材。
4. 用户可在运行中或等待重试时中断任务。中断必须停止当前请求、取消未来重试，并保留已完成检查点。
5. 用户可以从中断任务的已保存检查点继续。
6. 服务重启后必须恢复到期的重试任务，不丢失等待状态或完成结果。
7. 原片不可变、模型输入边界、确定性时间线、每条有效素材恰好进入一次 EditPlan、无硬字幕 MP4 等既有不变量不得改变。

### 1.1 非目标

- 不重做素材采样、视觉理解 Prompt、细节精查策略或 Remotion 成片格式。
- 不把原视频、音频、图片 base64 或 API Key 写入检查点或模型日志。
- 不对上传无效、缺少视频轨道、媒体编码不支持、连接配置缺失等确定性错误无限重试。
- 不在本次引入外部队列、Redis、云调度器或跨进程分布式锁；先在 SQLite 与当前单进程 Worker 模型内可靠实现。

## 2. 面向用户的合同

### 2.1 任务状态

在现有生成版本状态中增加：

```ts
type AutoVideoGenerationStatus =
  | 'queued'
  | 'analyzing'
  | 'retry_waiting'
  | 'planning'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'needs_attention';
```

语义：

| 状态 | 用户可见含义 | 是否可中断 | 是否自动恢复 |
| --- | --- | --- | --- |
| `analyzing` | 正在准备或理解素材 | 是 | 是，进程异常后恢复 |
| `retry_waiting` | 临时错误，正在等待下一次重试 | 是 | 是，到期后重试 |
| `planning` / `rendering` | 正在编排或生成成片 | 是 | 是，进程异常后恢复 |
| `cancelled` | 用户主动中断；已完成检查点被保留 | 否 | 否，需用户继续 |
| `needs_attention` | 不可恢复错误，需要处理素材或配置 | 否 | 否，需用户处理后继续 |
| `failed` | 遗留兼容状态；新流程仅用于未知内部错误 | 否 | 不自动无限重试 |

`retry_waiting` 必须被视为活跃生成版本：项目仍禁止修改素材，页面仍轮询任务进度，且显示“中断任务”按钮。

### 2.2 用户界面文案

版本详情的“处理任务”区域必须显示可理解的进度，不只显示全局百分比：

```text
画面理解：已完成 1 / 3 个素材
正在等待重试：第二段.mp4
第 5 次尝试失败：上游网关错误
将在 14:32:05 自动重试

[中断任务]
```

中断后显示：

```text
任务已中断。已保留 1 / 3 个素材的理解结果。

[从已保存断点继续]
```

运行中、规划中、渲染中与 `retry_waiting` 状态统一显示 **“中断任务”**。不再将用户操作描述为“取消此版本”，以免误解为删除版本或丢弃已完成结果。

模型对话记录仅作为审计页面，不承担中断或恢复任务的入口。

## 3. 检查点数据合同

检查点属于 `generationId`，而不是可跨版本共享的素材记录。视觉结果受到模型、连接、提示词快照和用户编排要求影响，不能写进共享的 `StoredAutoVideoAsset` 后被另一版本复用。

### 3.1 单素材检查点

新增共享类型和 Zod Schema：

```ts
type CheckpointStatus = 'pending' | 'running' | 'retry_waiting' | 'completed' | 'failed';

type AutoVideoAssetCheckpoint = {
  generationId: string;
  assetId: string;
  sourceChecksum: string;

  transcript: {
    status: 'pending' | 'completed' | 'skipped';
    value?: NormalizedTranscript;
    completedAt?: string;
  };

  screenshots: {
    status: 'pending' | 'completed';
    screenshotIds: string[];
    contactSheetPath?: string;
    completedAt?: string;
  };

  visualAnalysis: {
    status: CheckpointStatus;
    value?: AssetVisualAnalysis;
    attempts: number;
    lastError?: AutoVideoError;
    nextRetryAt?: string;
    completedAt?: string;
  };

  updatedAt: string;
};
```

约束：

- `sourceChecksum` 必须与生成版本素材快照对应。任何不匹配都视为数据完整性错误，不得复用检查点。
- `visualAnalysis.status === 'completed'` 时必须存在合法的 `value` 和 `completedAt`，且没有 `nextRetryAt`。
- `visualAnalysis.status === 'retry_waiting'` 时必须存在 `lastError`、`nextRetryAt`，且 `lastError.retryable === true`。
- 不保存图片 data URL、临时图片字节、原始音频、API Key 或完整 Relay 请求体。
- 需要复用的截图文件路径仍受现有媒体清理策略约束；检查点只保存由可信本地媒体层生成的 ID/路径引用。

### 3.2 生成版本重试状态

在 `AutoVideoGeneration` 增加：

```ts
type AutoVideoRetryState = {
  status: 'none' | 'waiting' | 'paused_by_user' | 'needs_attention';
  stage?: 'visual_analysis' | 'planning' | 'render';
  nextRetryAt?: string;
  totalAttempts: number;
  lastError?: AutoVideoError;
  updatedAt: string;
};
```

`retryState` 是用户界面和任务调度的汇总视图；单素材是否完成必须以 `AutoVideoAssetCheckpoint` 为准。

### 3.3 SQLite 设计

新增表而非把所有检查点塞入 generation 的 JSON 列：

```sql
CREATE TABLE auto_video_asset_checkpoints (
  generation_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (generation_id, asset_id)
);

CREATE INDEX auto_video_asset_checkpoints_generation_idx
  ON auto_video_asset_checkpoints (tenant_id, generation_id);
```

存储层必须提供：

```ts
getAutoVideoAssetCheckpoint(generationId, assetId, tenantId)
listAutoVideoAssetCheckpoints(generationId, tenantId)
saveAutoVideoAssetCheckpoint(checkpoint)
listDueAutoVideoGenerationRetries(now)
```

`saveAutoVideoAssetCheckpoint` 需在事务内执行，并采用“仅在 `updatedAt` 未被其他 worker 修改时写入”的乐观并发检查。发生竞争时重新读取并判断当前状态；不得用旧数据覆盖已经 `completed` 的检查点。

## 4. 错误分类与持续重试规则

### 4.1 可持续重试

下列错误必须标记为 `retryable: true`：

- HTTP `408`、`425`、`429`、`500`、`502`、`503`、`504`；
- Relay 网络连接失败、DNS 临时失败、连接被重置；
- 上游请求超时；
- 截图中所示的 `Upstream gateway error`。

对这类错误，任务不得先进入 `failed`，而应写入该素材的 `retry_waiting` 检查点与 `nextRetryAt`。

### 4.2 不可持续重试

下列错误进入 `needs_attention` 或明确失败状态：

- `INVALID_UPLOAD`、`UNSUPPORTED_ASSET`、`NO_VIDEO_STREAM`、`MEDIA_PROBE_FAILED`；
- 被用户取消；
- 模型连接/密钥已删除或当前模型不存在；
- 已完成 JSON 修复流程后仍然持续产生不符合 Schema 的模型响应。

对“模型响应结构错误”，先保留既有的受约束 JSON 修复请求。修复仍失败时，不允许无止境地重复同一张图片请求；应进入 `needs_attention`，并在界面展示模型日志中的可诊断摘要。

### 4.3 固定重试间隔

持久化的下一次时间按下式计算：

```text
nextRetryAt = now + 5 seconds
```

每次可恢复失败均在 5 秒后重试。持续重试没有固定次数上限；结束条件只有成功、用户中断或不可恢复错误。

每次失败必须记录：`generationId`、`assetId`、阶段、尝试次数、错误码、是否可重试和 `nextRetryAt`。日志绝不记录图片 base64、视频字节或密钥。

## 5. Worker 与调度器实施

### 5.1 禁止批量成功后才保存

当前类似下面的模式不得继续用于视觉理解结果：

```ts
const results = await mapWithConcurrency(assets, ...);
saveGeneration({ assetAnalyses: results });
```

必须改为每条素材独立推进：

1. 读取该素材检查点。
2. 若转写已完成，直接复用；否则完成转写后立即保存。
3. 若截图/联系表已完成且文件可用，直接复用；否则生成后立即保存。
4. 若基础视觉理解已完成，直接返回其 `value`，绝不再调用 Relay。
5. 若仍未完成，调用视觉模型；成功后立即将 `AssetVisualAnalysis` 写为 `completed`。
6. 只有全部素材的基础视觉理解都完成后，才汇总为 `AssetAnalysis[]` 并继续编排。

每个素材成功时更新 generation 的进度摘要，但不能因为另一个素材失败而回退任何已完成检查点。

### 5.2 按到期时间调度

不能在一个持有 worker 槽位的 `while (true)` 循环中睡眠重试。应实现一个进程内调度器：

```ts
scheduleGenerationRetry(generationId, nextRetryAt)
cancelScheduledGenerationRetry(generationId)
recoverScheduledGenerationRetries()
```

规则：

- 首次收到可重试失败时：保存检查点和 generation `retry_waiting` 状态，再注册一次定时器。
- 到期时：先重新从 SQLite 读取 generation 与素材检查点；仅当任务仍处于 `retry_waiting`、未取消、到期且该素材仍未完成时才入队。
- 应用启动时：查询所有 `nextRetryAt` 已到期或未来最近到期的 generation，并重新注册调度。
- 固定 5 秒等待低于单次 `setTimeout` 的平台上限；SQLite 中的 `nextRetryAt` 仍是唯一事实来源。
- 定时器仅是便利机制，SQLite 中的 `nextRetryAt` 才是事实来源。

### 5.3 并发与取消

现有 generation 级 `AbortController` 继续作为唯一中断信号，并扩展为：

- 取消正在等待 Relay 的请求；
- 取消等待信号量的任务；
- 清除该 generation 的未来重试计时器；
- 每次准备再次调用模型前检查“是否已取消”；
- 每次从 SQLite 读取检查点后也检查“是否已取消”。

一个 generation 同时只允许一个 Worker 持有执行权。`enqueue`、到期定时器、手动继续和进程恢复同时触发时必须去重；数据库状态仍须作为最终保护，避免同一素材同时发起两次模型调用。

### 5.4 取消与恢复

`POST /cancel` 的处理顺序：

1. 在事务内记录取消请求；
2. 清除持久化 `retryState.nextRetryAt`；
3. 取消内存调度器与 `AbortController`；
4. Worker 捕获取消后将 generation 标记为 `cancelled`；
5. 保留所有 `completed` 检查点及其可复用媒体引用。

新增：

```text
POST /api/projects/:projectId/generations/:generationId/resume
```

仅允许 `cancelled`、`retry_waiting` 或 `needs_attention`（错误条件已经被用户修复）状态调用。它必须：

- 清除取消标记；
- 保留全部完成检查点；
- 仅将未完成/可重试检查点恢复为 `pending` 或立即到期；
- 入队同一个 `generationId`，不创建新的版本。

“重新开始此版本”若未来需要，应是独立且需二次确认的操作，不能复用 `resume`。

## 6. 前端实施

### 6.1 API 与类型

扩展生成版本详情响应：

```ts
type AutoVideoGenerationView = {
  // 现有字段
  retryState?: AutoVideoRetryState;
  assetCheckpoints: AutoVideoAssetCheckpointSummary[];
};
```

前端只接收摘要，不接收截图路径、模型原始回复或敏感数据：

```ts
type AutoVideoAssetCheckpointSummary = {
  assetId: string;
  visualAnalysis: {
    status: CheckpointStatus;
    attempts: number;
    nextRetryAt?: string;
    lastError?: Pick<AutoVideoError, 'code' | 'message' | 'retryable'>;
    completedAt?: string;
  };
};
```

### 6.2 组件行为

在 `VersionDetail`：

- 当状态为 `analyzing`、`retry_waiting`、`planning` 或 `rendering` 时显示红色/危险操作样式的“中断任务”。
- 中断按钮只禁用自身，显示“正在中断…”，不阻塞仍在进行的状态轮询。
- 状态为 `cancelled` 时显示“从已保存断点继续”。
- `retry_waiting` 显示“已完成 X/Y”“正在等待哪个素材”“第 N 次尝试”“下一次重试时间”。
- 页面标题、版本列表、轮询条件和 `activeGenerationStatuses` 必须承认 `retry_waiting` 为活跃状态。
- 对 2 个或更多素材，显示简洁的素材级状态列表；不得只显示模糊的项目级“视觉理解失败”。

确认文案：

```text
中断后将停止当前模型调用和后续自动重试。
已完成的素材理解会保留，可随时从断点继续。确定中断吗？
```

## 7. 媒体清理与数据保留

当前成功/失败后清理临时分析文件的逻辑必须调整：

- `retry_waiting` 和 `cancelled` 生成版本不能清理未完成素材恢复所必需的截图、联系表和临时音频；否则恢复会失去断点的媒体输入。
- 可在最终 `completed`、不可恢复 `needs_attention` 且用户明确放弃、或版本被明确删除时进行清理。
- 细节精查用的单张临时截图在该次精查结束后仍可按现有策略删除，因为基础视觉理解检查点已经完整存在。
- 任何清理失败只记录告警，不能改变已完成检查点状态。

需要在文档和界面中明确：检查点属于生成版本，并非永久素材索引；版本保留期间需要保留其可恢复所需的受控临时产物。

## 8. 实施顺序

按以下小步实施，每步都可单独验证：

1. **数据合同与迁移**：增加 Zod Schema、SQLite checkpoint 表、存储接口和旧版本兼容读取。
2. **单素材保存**：改造平衡理解 worker，使转写、截图和基础视觉结果成功后立即持久化。
3. **汇总与复用**：从完成 checkpoint 构建 `assetAnalyses`，验证已完成素材不会再次调用 Relay。
4. **重试调度**：增加可恢复错误分类、固定 5 秒的持久化等待、定时器、启动恢复与入队去重。
5. **中断与继续 API**：完善取消语义，新增 `resume`，验证中断能够取消当前请求和定时任务。
6. **前端任务控制**：展示每素材进度、下一次重试时间、“中断任务”和“从断点继续”。
7. **清理策略**：保证等待/取消任务可恢复，最终完成后按规则清理。
8. **回归测试与构建**：运行完整服务端测试、类型检查、生产构建及浏览器交互验收。

不得在第 4 步前实现“无限重试”；没有单素材检查点的无限重试会重复消耗已成功素材的模型调用。

## 9. 验收测试

至少新增以下自动化与人工验收：

| 编号 | 场景 | 必须证明的结果 |
| --- | --- | --- |
| 1 | 素材 1 成功、素材 2 首次 HTTP 500、第二次成功 | 素材 1 基础视觉调用次数始终为 1；素材 2 被重试并最终完成。 |
| 2 | 素材 1、2 成功，素材 3 持续 503 | generation 为 `retry_waiting`；前两条检查点保持 `completed`；定时器不占用 worker 槽位。 |
| 3 | `retry_waiting` 时点击中断 | 计时器被取消，到期后没有新的 Relay 请求，状态为 `cancelled`。 |
| 4 | 正在等待 Relay 时点击中断 | 请求收到 AbortSignal；状态不再被后续异常覆盖为 `failed`。 |
| 5 | 中断后点击继续 | 只调用未完成素材，已完成素材的 Relay 调用计数不增加。 |
| 6 | 服务在等待重试期间重启 | 启动恢复定时任务；到期后仅处理未完成素材。 |
| 7 | 429、500、502、503、504 与超时 | 都持久化为可重试错误，每次失败后固定等待 5 秒。 |
| 8 | 无视频轨道/不支持编码/Key 已删除 | 进入 `needs_attention` 或不可重试失败，不产生无限调用。 |
| 9 | 两个入队来源同时恢复同一 generation | 同一素材在同一时间最多一次模型调用；没有重复覆盖 completed checkpoint。 |
| 10 | 历史 generation 没有 checkpoint 记录 | 页面与 Worker 正常读取；首次恢复按兼容路径创建检查点。 |
| 11 | 浏览器界面 | `retry_waiting` 显示完成数、失败素材、下一次时间和中断按钮；取消后显示继续按钮。 |

人工验收流程：使用至少三段素材，故意让第二段视觉请求前两次返回 500，再恢复正常。确认第一段只请求一次、第二段自动重试成功、第三段没有被第一段的成功结果影响；然后再制造一次等待重试并点击“中断任务”，确认继续后只补做失败素材。

## 10. 完成定义

本规格完成必须同时满足：

1. 发生可恢复视觉错误时，任务自动进入 `retry_waiting`，而不是立刻失败。
2. 已完成素材的画面理解在同一 generation 内可跨重试、取消、恢复和服务重启复用。
3. 用户可中断运行中及等待重试的任务，并能从已保存断点继续。
4. 不可恢复错误不会无限重试，页面能展示可操作原因。
5. 所有新增状态、API、存储迁移、日志、类型和界面文案具有自动化测试覆盖。
6. `pnpm test`、`pnpm build` 以及浏览器中断/恢复交互验收均通过。
