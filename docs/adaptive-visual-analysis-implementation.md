# 自适应视觉理解与快速编排：AI 实施规格

> 文档版本：v1.0  
> 面向对象：负责 TypeScript、Express Worker、媒体处理、模型调用、React 界面和自动化测试的 AI 编码代理  
> 实施状态：待实施  
> 默认策略：平衡档（balanced-v1）

## 1. 实施目标

将当前“每个截图单独调用视觉模型，再单独调用模型理解素材”的流程，升级为“每条素材一次基础联合理解，按不确定性追加精查”的自适应流程。

本次改造必须同时满足以下目标：

1. 每条素材仍覆盖早、中、晚三个时间点，不能为了提速只分析单个中间帧。
2. 默认模式下，每条素材只进行一次基础视觉模型调用。
3. 将模型返回的常见对象型字段安全规范化，避免已成功返回 JSON 的模型调用因字段形状不同而使整个任务失败。
4. 只对确有必要的素材追加高精度视觉调用，且项目级调用次数受预算约束。
5. 原片不可变、每个有效素材完整播放一次、确定性时间线、无硬字幕成片等现有不变量不得改变。
6. 不改变已有项目、版本、上传、下载和模型连接 API 的默认行为；旧版本仍可读取。

## 2. 当前瓶颈与目标指标

当前短素材默认提取早、中、晚三张截图。对一个有 N 条素材的项目，连接模型模式大致会发生：

~~~text
3N 次截图视觉分析
+ N 次素材综合理解
+ 1 次整体编排
~~~

以 17 条素材为例，基础模型调用约为 69 次；字段格式不匹配时，每张截图还会重复调用，导致时间和费用进一步上升。

改造后的平衡档目标：

~~~text
N 次“拼图 + 转写 + 元数据”的联合素材理解
+ 最多 6 次不确定素材精查
+ 1 次整体编排
~~~

对于 17 条素材，目标是 18 至 24 次模型调用。这里的“模型调用”不包括 Qwen 语音转写和 Remotion 渲染。

| 指标 | 当前基线 | balanced-v1 目标 |
| --- | --- | --- |
| 基础视觉调用 | 3 次 / 素材 | 1 次 / 素材 |
| 素材综合理解调用 | 1 次 / 素材 | 合并入基础视觉调用 |
| 追加视觉调用 | 无上限的逐截图重试 | 每项目最多 6 次 |
| 模型输出字段错误 | 容易被笼统归为视觉分析失败 | 归一化或明确报为 INVALID_MODEL_RESPONSE |
| 短素材画面覆盖 | 早、中、晚 | 早、中、晚 |
| 17 条素材的模型调用量 | 约 69 次，未含重试 | 18 至 24 次 |

在当前模型响应通常为 15 至 35 秒、模型并发为 6 的条件下，模型理解阶段的合理目标是约 60 至 150 秒。最终 MP4 的时间仍主要受 1080×1920、30fps 的 Remotion 渲染影响，本方案不会为了提速自动降低最终成片规格。

## 3. 不变量与非目标

### 3.1 不变量

- 原始视频仍只能读取，不能裁切、转码、覆盖、变速、调色或改写音轨。
- 每个有效素材在有效 EditPlan 中必须恰好出现一次，时间线继续由程序计算。
- 视觉模型只接收临时 JPEG 或由临时 JPEG 合成的拼图；不得接收原始视频路径、完整视频、原始音频或 API Key。
- 模型对话日志不得存储图片 base64、视频字节或 API Key。
- 所有临时截图、拼图和分析音频均在处理完成后清理。
- 无模型连接时，仍走现有本地确定性顺序合成，不得假称已理解画面。

### 3.2 非目标

- 不在本次改造中引入镜头级裁切、特效、配乐、字幕烧录或自动调色。
- 不更换 Qwen 转写网关、Relay 服务商或 Remotion 的成片格式。
- 不要求用户在界面中选择多个分析档位；第一版固定使用 balanced-v1。后续可以再暴露“极速 / 平衡 / 精细”选项。
- 不在没有基准数据前盲目提高任务级 Worker 并发。

## 4. 目标处理链路

~~~mermaid
flowchart LR
  A["不可变原片"] --> B["并行：媒体探测、临时音频转写、早中晚截图"]
  B --> C["3 帧生成 2×2 临时拼图"]
  C --> D["每素材一次联合理解：拼图 + 转写 + 元数据"]
  D --> E{"置信度或顺序是否不确定？"}
  E -- "否" --> G["素材分析快照"]
  E -- "是，预算未耗尽" --> F["最多一次高精度精查"]
  F --> G
  G --> H["一次整体编排"]
  H --> I["确定性时间线"]
  I --> J["Caption / WebVTT"]
  I --> K["Remotion 最终 MP4"]
~~~

“联合理解”必须直接产出可用于整体编排的素材级结论，不能在完成后再发起一轮模型调用来做同义的素材总结。

## 5. 默认运行配置

新增以下配置。变量未设置时必须使用文档中的默认值。

~~~env
# 同一时间运行的完整生成版本；保持为 1，避免渲染与分析抢占机器资源。
AUTO_VIDEO_WORKER_CONCURRENCY=1

# FFmpeg 的媒体准备并发上限：截图、音频提取等本地 CPU/磁盘任务。
AUTO_VIDEO_MEDIA_CONCURRENCY=3

# 同时发送到视觉/理解模型的请求上限。必须是全局信号量，不得按素材嵌套放大。
AUTO_VIDEO_MODEL_CONCURRENCY=6

# 每个项目在基础理解完成后最多增加的精查调用数。
AUTO_VIDEO_VISUAL_DETAIL_BUDGET=6

# 低于此置信度时可请求精查。取值必须在 0 到 1 之间。
AUTO_VIDEO_VISUAL_DETAIL_CONFIDENCE=0.65

# 基础理解阶段的结构化结果不合法时，最多一次修复性重试；不要保留盲目两次图像重试。
AUTO_VIDEO_VISUAL_MAX_RETRIES=1
~~~

约束：

- 当前实现中“素材并发 × 每素材三张截图并发”会产生嵌套并发。改造后必须改为由 AUTO_VIDEO_MODEL_CONCURRENCY 唯一控制所有模型请求。
- 已观察到当前中转站可以处理约 6 个并发截图请求；在没有新的压测结论前不得提高默认值。
- 媒体处理和模型请求必须使用独立信号量。一个正在等待模型响应的素材不得占用 FFmpeg 槽位。

## 6. 数据与契约设计

### 6.1 新增分析配置快照

在 AutoVideoGeneration 中增加可选的 analysisProfile。新创建的连接模型版本必须写入；历史版本缺失时按 legacy-v1 读取，不进行破坏性迁移。

~~~ts
type AnalysisProfile =
  | {
      name: 'balanced-v1';
      sampledFramesPerAsset: 3;
      detailBudget: number;
      modelConcurrency: number;
    }
  | {name: 'legacy-v1'};
~~~

用途：

- 让历史版本的分析策略可审计、可复现。
- 让重试沿用创建时快照，而不是读取之后被修改的环境变量。
- 前端可显示“平衡理解模式”，无需暴露内部并发数。

### 6.2 联合素材理解响应

新增内部 Schema，例如 assetVisualAnalysisSchema。模型输出必须保持扁平、易于中转站稳定返回的字段形状。

~~~ts
type AssetVisualAnalysis = {
  assetId: string;
  visualSummary: string;
  people: string[];
  objects: string[];
  actions: string[];
  scenes: string[];
  screenTexts: string[];
  chronologicalHints: string[];
  suggestedPosition: 'opening' | 'middle' | 'unknown' | 'ending';
  confidence: number;
  needsDetail: boolean;
  detailReason?: string;
  detailTimestampMs?: number;
};
~~~

规则：

- 所有数组元素只能是纯文本字符串，不允许对象、数组或 null。
- confidence 必须在 0 到 1 之间。
- needsDetail 为 false 时，不得读取 detailReason 或 detailTimestampMs。
- detailTimestampMs 存在时必须在该素材时长范围内。
- visualSummary 和 chronologicalHints 必须只描述输入拼图、转写与媒体元数据中可证实的内容。

服务端将该结果和 NormalizedTranscript、AssetMetadata 合并为现有 AssetAnalysis。只要字段已经足以形成 AssetAnalysis，就不得再调用模型的 understandAsset。

### 6.3 模型提示和 JSON Schema

基础联合理解的提示必须明确说明字段类型，而不是仅列字段名。提示中必须包含类似要求：

~~~text
只返回一个 JSON 对象，不使用 Markdown。
people、objects、actions、scenes、screenTexts、chronologicalHints 必须是字符串数组。
数组中的每一项必须是完整短句，不得是对象、嵌套数组、数字或 null。
confidence 是 0 到 1 的数字。
scene / scenes 只使用文本描述，不返回 location、lighting 等嵌套对象。
~~~

若 Relay 支持 Responses API 结构化输出，requestTextOnce 必须在 text.format 中传递 JSON Schema 并开启 strict。需要兼容不支持该能力的中转站：

1. 将 structured output 是否实际启用记录到 generation 的可观测性日志中；analysisProfile 只记录策略参数，不记录运行时能力探测结果。
2. 首次因不支持 text.format 收到明确 4xx 时，在同一请求链路中回退到“严格提示 + 服务端归一化”。
3. 回退只对能力不支持生效；不得因为模型返回不合法字段而重新发起无约束调用。

### 6.4 结果归一化

在 Zod 严格校验之前，新增纯函数 normalizeVisualModelValue。它必须：

1. 接收 unknown，绝不抛出未分类异常。
2. 对数组字段逐项归一化：
   - string：trim 后保留；
   - object：按 description、text、name、action、details 的顺序提取第一个非空字符串；
   - 其他值：丢弃并记入 validation diagnostics。
3. 对 scenes：
   - string：转为单元素数组；
   - object：合并 location、environment、lighting、cameraView 等非空文本，以“；”连接；
   - array：按上条数组规则归一化。
4. 去重、截断到既有上限，并删除空字符串。
5. 输出归一化后的值和 diagnostics，例如 normalizedFields、droppedItems、unrecoverablePaths。

归一化后再执行 Schema 校验。若仍失败：

- 抛出 INVALID_MODEL_RESPONSE，而不是 VISUAL_ANALYSIS_FAILED；
- 错误详情必须包含安全的字段路径，例如 people[0] 或 confidence；
- 原始模型回复仅保留在已有模型对话审计中，不能写入用户错误提示；
- 只允许一次修复性重试；修复提示可复用原结构化输入和原始回复文本，但不得再上传图片。

## 7. 拼图生成

### 7.1 采样规则

balanced-v1 对每条素材固定采样：

1. early：min(300ms, duration × 0.02)；
2. middle：duration ÷ 2；
3. late：max(0ms, duration - 300ms)。

不得因素材时长很短而产生重复时间点。若去重后只有 1 或 2 张，拼图只包含实际存在的面板，模型输入中必须说明实际面板数。

现有 screenshotTimestamps 包含更密集的长视频采样。改造后：

- balanced-v1 基础阶段只取上述三个点；
- 精查阶段只提取模型建议或规则确定的一个额外时间点；
- legacy-v1 保持原采样逻辑，确保旧版本重试和读取兼容。

### 7.2 图像布局

使用临时 JPEG 创建 2×2 联系表：

- 每个面板限制在 512×896 像素内，保持比例后留黑边；
- 早、中、晚分别放在 A、B、C 面板；D 为黑色占位；
- 不依赖本机字体绘制文字；
- 在模型结构化输入中传递 panel 到 timestampMs 的映射；
- 拼图只存放在 temporary 目录，并和原截图一起清理。

推荐使用现有 FFmpeg 运行封装，不新增重量级图像处理依赖。可通过 scale、pad、hstack、vstack 组合生成拼图。所有输入均为临时 JPEG，禁止把原始视频写入该链路。

结构化输入示例：

~~~json
{
  "schema": "auto-video-asset-visual-analysis.v1",
  "assetId": "asset_x",
  "metadata": {"durationMs": 4300, "width": 1080, "height": 1920},
  "transcript": {"text": "可选的已规范化转写"},
  "contactSheet": {
    "panels": [
      {"id": "A", "timestampMs": 86},
      {"id": "B", "timestampMs": 2150},
      {"id": "C", "timestampMs": 4000}
    ]
  },
  "userInstruction": "请依据内容自然衔接全部素材"
}
~~~

## 8. 自适应精查

基础联合理解完成后，只有满足任一条件的素材才可以申请精查：

- confidence 小于 AUTO_VIDEO_VISUAL_DETAIL_CONFIDENCE；
- needsDetail 为 true 且模型提供了合法 detailTimestampMs；
- 有 OCR 文字但基础图分辨率不足以确认关键文案；
- 多条素材被判定为相似或顺序线索相互冲突；
- 用户要求明确时间顺序，而该素材没有足够的 chronologicalHints。

精查规则：

1. 按“置信度最低、顺序影响最大、OCR 影响最大”的优先级排序。
2. 同一素材最多一次精查。
3. 项目总数不能超过 analysisProfile.detailBudget。
4. 精查只上传一张高精度临时 JPEG，并带上基础分析结果。
5. 精查模型只返回补充字段；服务端与基础结果合并，不得覆盖已确认的 assetId、媒体元数据或转写。
6. 精查失败但基础结果有效时，保留基础结果并记录 warning；只有无可用基础结果时才让整个版本失败。

## 9. Worker 改造顺序

以下顺序是实现时的强制执行顺序。每一步完成后都必须运行对应测试，禁止先大规模重写 Worker。

### 步骤 1：补齐 Schema、归一化和错误分类

修改目标：

- src/server/auto-video-ai.ts
- src/shared/auto-video-contracts.ts（如需声明 analysisProfile 或内部类型）
- src/server/auto-video-worker.ts

要求：

1. 添加 normalizeVisualModelValue 的单元测试。
2. 保留既有 screenshotAnalysisSchema 的读兼容性。
3. 将“模型返回合法 JSON 但字段形状不符合契约”明确转换为 INVALID_MODEL_RESPONSE。
4. 现有 VISUAL_ANALYSIS_FAILED 仅表示模型网络、视觉调用或无法获得可用视觉结果。

### 步骤 2：实现临时联系表生成和清理

修改目标：

- src/server/auto-video-media.ts
- src/server/auto-video-media.test.ts 或现有 auto-video.test.ts

要求：

1. 新函数输入 StoredVideoScreenshot[]，输出临时拼图路径和面板时间映射。
2. 对 1、2、3 张截图均可工作。
3. 任一 FFmpeg 失败时，清理已产生的联系表并报告 SCREENSHOT_EXTRACTION_FAILED。
4. cleanupAssetAnalysisFiles 必须同时删除联系表。

### 步骤 3：实现联合素材理解

修改目标：

- src/server/auto-video-ai.ts
- src/server/auto-video-worker.ts

要求：

1. 添加 analyzeAssetVisualSummary，而不是在新链路上继续调用每帧 analyzeScreenshot。
2. 它一次接收联系表、转写、媒体元数据、用户要求和面板映射。
3. 由服务端本地合成最终 AssetAnalysis，不能再发起 understandAsset 模型调用。
4. 现有 legacy-v1 保持旧链路，方便回退和历史重试。

### 步骤 4：加入全局并发控制与精查预算

修改目标：

- src/server/auto-video-worker.ts
- 配置读取与运行说明

要求：

1. 媒体准备、模型请求各自使用独立信号量。
2. 所有基础理解、精查、整体编排模型调用共享同一个模型信号量。
3. 记录模型队列等待时间和实际调用数。
4. 任务取消必须中断等待中的媒体和模型请求。

### 步骤 5：保存分析策略快照与前端文案

修改目标：

- src/shared/auto-video-contracts.ts
- src/server/store.ts
- src/client/AutoVideoApp.tsx 及相关组件

要求：

1. 创建 generation 时写入 balanced-v1 快照。
2. 历史 generation 缺失该字段时显示“旧版分析策略”，不能解析失败。
3. 前端处理页显示“正在进行三段关键画面联合理解”；仅在触发时显示“正在补充分析关键片段”。
4. 错误界面必须显示“模型回复格式不符合要求，可重试”，不得把结构错误描述为素材或视觉服务故障。

## 10. 失败与降级策略

| 场景 | 处理 | 用户可见结果 |
| --- | --- | --- |
| Relay HTTP、SSE 或超时失败 | 保持既有网络重试；耗尽后失败 | 视觉模型连接失败，可重试 |
| 模型输出不是 JSON | 一次无图片修复性重试；仍失败则 INVALID_MODEL_RESPONSE | 模型回复格式不符合要求，可重试 |
| JSON 字段是对象而非字符串 | 服务端归一化后继续 | 不向用户暴露错误 |
| 归一化后仍缺关键字段 | INVALID_MODEL_RESPONSE，记录字段路径 | 模型回复格式不符合要求，可重试 |
| 一条素材的精查失败 | 保留有效基础结果，记录 warning | 使用基础画面理解继续编排 |
| 基础理解完全失败 | 版本失败 | 明确显示发生在哪条素材、哪个阶段 |
| 未配置模型 | 继续使用现有本地顺序合成 | 明确说明未进行 AI 画面理解 |

## 11. 可观测性

每个 generation 至少记录以下指标，并禁止记录媒体字节或密钥：

~~~ts
{
  analysisProfile: 'balanced-v1',
  assetCount: number,
  baseVisualCalls: number,
  detailVisualCalls: number,
  normalizedModelFields: number,
  invalidModelResponses: number,
  modelQueueWaitMs: number,
  modelRequestMs: number,
  mediaPreparationMs: number,
  renderMs?: number
}
~~~

模型对话记录必须额外标记 source：

- auto-video.asset-visual-summary
- auto-video.asset-visual-detail
- auto-video.planning
- auto-video.visual-repair（仅在实际修复重试时）

## 12. 测试与验收

### 12.1 单元测试

必须新增或更新以下测试：

1. 对象型 people、objects、actions、ocrText 能被转换为字符串数组。
2. scene 为对象时能转换为文本场景描述。
3. 不可恢复的字段形状返回 INVALID_MODEL_RESPONSE，并带安全字段路径。
4. 基础采样对短视频始终包含早、中、晚且没有重复时间点。
5. 1、2、3 张截图都能生成临时联系表，清理时联系表也被删除。
6. N 条素材的基础联合理解只产生 N 次模型调用。
7. detailBudget=6 时，17 条素材的总精查调用不超过 6。
8. 精查失败不会推翻已有有效基础分析。
9. legacy-v1 generation 仍可以反序列化、读取和重试。
10. 取消任务时不会留下联系表、临时截图或等待中的模型请求。

### 12.2 集成测试

使用一个包含至少 6 条、总计 30 至 90 秒的视频项目验证：

1. 每条素材都拥有早、中、晚面板和有效的素材分析。
2. 基础模型调用数等于素材数。
3. 总视觉调用数不超过“素材数 + detailBudget”。
4. EditPlan 包含每个有效素材各一次，顺序连续。
5. 生成 timeline 后每条素材完整播放，原片哈希未改变。
6. Caption、VTT 和最终 MP4 均可生成。
7. 将测试 Relay 设为返回对象型字段时，任务仍能完成或报出 INVALID_MODEL_RESPONSE，绝不能错误归因为 VISUAL_ANALYSIS_FAILED。

### 12.3 当前失败任务的回归验证

对项目 project_c0567b2f-ff73-4e79-96b3-62028d1d91d2 的失败 V2：

1. 先在隔离测试副本或新 generation 上执行，不能修改已完成 V1 的产物。
2. 验证模型返回对象型 people、objects、actions、scene、ocrText 时被正确归一化。
3. 观察基础视觉调用最多为 17 次；精查调用最多为 6 次。
4. 成功进入 planning、timeline、captions 和 render 阶段。
5. 完成后确认新版本输出不覆盖旧版本 MP4。

## 13. 交付检查清单

- [ ] balanced-v1 是连接模型模式下的新默认策略。
- [ ] 旧 generation 保持可读、可重试。
- [ ] 每条素材以早、中、晚三帧参与一次基础理解。
- [ ] 不再对每张基础截图分别调用模型。
- [ ] 服务端能规范化常见对象型视觉字段。
- [ ] 未恢复的结构错误显示为 INVALID_MODEL_RESPONSE。
- [ ] 基础理解、精查、编排共享全局模型并发控制。
- [ ] 精查调用受项目级预算限制。
- [ ] 临时截图和联系表能够在成功、失败与取消后清理。
- [ ] 新增测试、类型检查、pnpm test 和 pnpm build 全部通过。
- [ ] 使用新 generation 验证当前失败任务，不覆盖历史成片。
