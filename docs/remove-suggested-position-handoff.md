# 移除单素材 `suggestedPosition`：问题交接与实施规格

> 状态：已实施（2026-08-17）  
> 日期：2026-08-17  
> 范围：自动视频生成的逐素材视觉理解、素材分析、全量编排与本地降级编排  
> 非范围：原片处理、截图采样、转写、`finalClipOrder` 校验、字幕和渲染

## 1. 结论与目标

移除单素材分析中的 `suggestedPosition` 字段及其 `opening`、`middle`、`unknown`、`ending` 标签。它不是原片拼接、字幕生成或最终素材顺序的必要输入，并且当前会把已经正确完成的画面理解错误地升级为“格式修复失败”。

最终顺序仍由全量编排阶段基于全部素材的内容说明、画面元素、转写、时间线索和用户要求生成 `finalClipOrder`。程序继续校验：同一任务的每个有效 `clipId` 必须恰好出现一次，时间线严格按该顺序读取原始片段。

## 2. 已观察到的问题

同一联系表会重复出现如下交替日志：

```text
auto-video.asset-visual-summary  completed
auto-video.visual-repair         failed (HTTP 502)
等待 5 秒
auto-video.asset-visual-summary  completed
auto-video.visual-repair         failed (HTTP 502)
```

这不是图片理解失败。`asset-visual-summary` 已能稳定返回正确的 JSON、画面说明、物体、动作、屏幕文字和 A/B/C 时间顺序。失败由 `suggestedPosition` 造成：模型自然地返回一段“适合作为外观精洗流程片段”的说明文字，但现有 Zod 合同只接受四个枚举值。

示例：

```json
{
  "suggestedPosition": "按原始顺序作为汽车美容服务介绍中外观精洗环节的连续镜头，可衔接在服务项目说明之后。"
}
```

由于该值不属于现有枚举，基础结果未被保存，程序转而调用 `auto-video.visual-repair`。该修复请求仍使用严格 Schema 的中转调用，当前中转站会返回 HTTP 502。修复失败后，素材检查点保持未完成状态；Worker 按固定 5 秒重试，重新发送相同联系表。

## 3. 当前通信状态

已实施的调整：带图片的视觉理解（联系表基础理解、单截图理解、可选精查）已改用“模型对话测试”的普通图文通信方式：一条用户消息包含提示词与结构化输入，图片作为该消息的 `input_image`，不发送 Responses `text.format/json_schema`。

尚存路径：`auto-video.visual-repair` 仍调用 `requestJson(..., assetVisualResponseFormat)`，因此仍使用 API 级严格 JSON Schema。移除 `suggestedPosition` 后，基础视觉结果不应再因为该字段触发这条修复路径；其他真正的 JSON/数据合同错误仍可按后续实现选择保留或简化修复。

## 4. 为什么单素材位置标签不应存在

单个素材无法可靠决定它在整条广告中的全局位置：同一段“泡沫冲洗”既可能是吸引注意的开场、服务过程展示，也可能是效果佐证。位置判断必须在收集全部素材之后完成。

现有字段的实际用途仅有：

1. 作为联网编排模型的弱参考；它不直接决定 `finalClipOrder`。
2. 在未配置联网模型的本地降级模式中，按 `opening → middle → unknown → ending` 排序。

这两个用途都不是业务不变量。联网编排模型可直接基于完整素材集决定顺序；本地降级模式使用稳定的上传顺序即可。

## 5. 目标数据合同

### 5.1 视觉理解输出

移除 `suggestedPosition`，保留如下字段：

```ts
type AssetVisualAnalysis = {
  assetId: string;
  visualSummary: string;
  people: string[];
  objects: string[];
  actions: string[];
  scenes: string[];
  screenTexts: string[];
  chronologicalHints: string[];
  confidence: number;
  needsDetail: boolean;
  detailReason?: string;
  detailTimestampMs?: number;
};
```

### 5.2 素材综合分析输出

`AssetAnalysis` 同样移除 `suggestedPosition`。编排输入继续包含：`assetId`、音频/视觉/综合摘要、话题、人物、场景、屏幕文字、时间线索、置信度和素材时长。

### 5.3 全量编排输出

不变：

```ts
type EditPlan = {
  projectId: string;
  clips: Array<{assetId: string; order: number; reason: string}>;
  excludedAssets: [];
  overallReason: string;
};
```

`validateAutoEditPlan` 仍是最终强制约束：所有有效素材各一次、无遗漏、无重复、顺序从 1 连续递增。

## 6. 实施范围

### 6.1 共享合同与提示词

1. 在 `src/shared/auto-video-contracts.ts` 中移除 `AssetVisualAnalysis` 与 `AssetAnalysis` 的 `suggestedPosition` Schema/类型字段。
2. 在 `src/server/auto-video-ai.ts` 中删除视觉理解、精查和素材综合理解 Prompt 的该字段说明。
3. 删除 `assetVisualResponseFormat` 中的该属性与 required 项；若该 Schema 仅服务于视觉修复，可随修复策略一并简化。
4. `toAssetAnalysis` 不再复制该字段。

### 6.2 编排逻辑

1. 删除 `positionRank`。
2. 删除本地 `plan()` 中基于该字段的排序逻辑。
3. 本地无模型降级模式保持 `validAssetIds` 的既有上传顺序，并在 `overallReason` 中明确说明“按上传顺序完整合成”。
4. 联网的 `planningInstructions` 不再提及开头/中段/结尾位置标签；模型只基于全部素材的实际内容和时间线索生成完整顺序。

### 6.3 格式修复与重试

1. 移除因 `suggestedPosition` 触发的视觉修复分支。
2. 保留其他字段的本地 Schema 校验，防止资产 ID、数组类型、置信度和精查时间戳不合法。
3. 不允许因已经成功的图片理解结果仅缺少全局位置标签而再次发送联系表。
4. 对真正的 JSON 解析失败或必要字段缺失，保留现有可诊断错误与用户可中断的重试行为；是否保留模型修复由实施者另行决定，但不得重新引入本字段。

### 6.4 历史数据兼容

已有数据库中的生成版本、检查点和模型日志可能仍包含 `suggestedPosition`。

- 读取旧 JSON 时应允许并忽略该额外字段，或在读取边界明确剥离它。
- 新写入的 `AssetVisualAnalysis`、`AssetAnalysis` 和模型请求不再生成它。
- 不得通过破坏性迁移修改原始素材、已完成时间线或模型审计记录。
- 需要检查所有 `.strict()` Schema 的历史读取路径，避免旧记录因多出一个字段而变成不可读。

## 7. 验收条件

### 必须通过

1. 视觉提示词、响应 Schema、共享 TypeScript 类型和保存结果都不再包含 `suggestedPosition`。
2. 模型返回一段位置说明文字、或完全不返回位置字段时，基础视觉理解仍可成功保存。
3. 对同一张联系表，成功的 `auto-video.asset-visual-summary` 不会再紧跟仅由位置标签导致的 `auto-video.visual-repair`。
4. 在中转站返回正常 JSON 的情况下，每条素材只进行一次基础联系表理解；不会因移除的字段循环重试。
5. 联网编排仍生成包含全部有效 `assetId` 且各一次的 `finalClipOrder`。
6. 本地降级编排按上传顺序生成完整顺序。
7. 旧生成版本和检查点仍可读取；它们遗留的 `suggestedPosition` 不阻断恢复或查看。

### 建议新增测试

1. 视觉模型返回没有 `suggestedPosition` 的合法基础结果，`analyzeAssetVisualSummary` 成功。
2. 视觉模型返回旧式说明文本作为 `suggestedPosition`，兼容读取边界忽略该字段并成功。
3. 本地 `plan()` 在无该字段时保留输入资产顺序。
4. 连接模型的 `EditPlan` 仍拒绝遗漏、重复或非法资产 ID。
5. 历史检查点 JSON 含旧字段时能够读取，且新保存结果不再含旧字段。

## 8. 相关代码定位

- `src/shared/auto-video-contracts.ts`：共享 Zod Schema 和 TypeScript 类型。
- `src/server/auto-video-ai.ts`：视觉提示词、`AssetVisualAnalysis` 解析、`toAssetAnalysis`、本地与联网编排。
- `src/server/auto-video-worker.ts`：单素材检查点、视觉结果保存、可恢复重试。
- `src/server/relay-client.ts`：普通图片聊天传输与遗留结构化请求传输。
- `src/server/auto-video.test.ts`：合同、联系表和视觉请求回归测试。
- `src/server/store.ts`：生成版本/检查点的历史记录读取与持久化。

## 9. 风险与边界

- 移除单素材位置标签不会降低“全部素材恰好一次”的强制性；该强制性由 `validateAutoEditPlan` 和时间线校验承担。
- 移除后，联网编排质量依赖全量素材内容、转写与时间线索，而不是单素材猜测位置；这符合当前产品目标。
- 本地降级模式不再尝试营销语义排序，改为稳定、可解释、无遗漏的上传顺序。
- 本文的合同、编排与兼容策略已实施：新运行代码不再生成该字段，历史记录在读取边界忽略它；视觉修复仅保留给真正的 JSON 或必要字段错误。
