# 口播优先的整批 MarketingRole 判断：AI 实施方案

> 文档状态：已实施，真实回归见《口播优先整批 MarketingRole 判断：实施与回归报告》
> 编写日期：2026-09-01
> 适用项目：`D:\短视频\washcut-agent-demo`
> 目标：在 ASR 与画面理解全部完成后，整批判断素材的广告叙事作用，再进行全量顺序编排

## 1. 背景与问题

当前程序在每条素材的视觉分析阶段判断 `marketingRole`。视觉模型只读取联系表图片、媒体元数据和用户要求，不读取 ASR 文本；之后的素材结论步骤只是把视觉结果与转写拼接起来，并沿用视觉模型已经给出的角色。全量编排模型虽然收到 `audioSummary` 和 `visualSummary`，但只返回顺序与理由，不会修正已经保存的 `marketingRole`。

真实主包测试暴露了这一偏差：提问式口播被标为 `process`，效果口播被标为 `process`，到店引导口播被标为 `transition`。这说明现有结果更接近“画面动作分类”，没有准确表达素材在广告叙事中的作用。

本项目面向抖音洗车营销短视频，口播和字幕构成广告叙事主轴；画面主要负责证明服务场景、维持观看节奏和优化镜头衔接。因此应把 `marketingRole` 的最终判断移动到 ASR 与画面理解完成之后、顺序编排之前。

## 2. 目标与非目标

### 2.1 目标

- ASR 和视觉分析继续并行执行。
- 等同一版本全部素材的 ASR 与视觉分析完成后，只调用一次整批角色判断模型。
- 由真实口播、客观画面总结、画面文字和用户要求共同判断每条素材的最终 `marketingRole`。
- 有有效口播时，以口播表达的广告意图为主要依据。
- 普通音画动作不一致允许作为洗车 B-roll，不因此覆盖口播的广告作用。
- 涉及价格、优惠、门店、服务承诺或清洁效果的明确冲突必须在判断理由中说明。
- 全量编排读取已经确定的角色，并以口播叙事为主、画面衔接为辅生成顺序。
- 继续保证全部有效素材在 `finalClipOrder` 中各出现一次。

### 2.2 非目标

- 不增加 `visualRole`、`audioRole`、`finalNarrativeRole` 三套公开角色。
- 不扩充现有九个 `marketingRole` 标签。
- 不引入复杂的多级冲突数据模型。
- 不修改 Qwen3-ASR、字幕生成和 Remotion 渲染逻辑。
- 不改写历史生成版本或历史数据库记录。
- 不为了覆盖九类作用而强制模型分配不存在的角色。

## 3. 保持不变的 MarketingRole 合同

当前九类标签继续使用：

```ts
type MarketingRole =
  | 'hook'
  | 'problem'
  | 'service'
  | 'process'
  | 'detail'
  | 'result'
  | 'offer'
  | 'cta'
  | 'transition';
```

含义如下：

| 标签 | 广告叙事含义 |
| --- | --- |
| `hook` | 开场提问、利益点或其他吸引注意的表达 |
| `problem` | 用户痛点、污渍、难清理问题 |
| `service` | 服务范围、项目和标准介绍 |
| `process` | 喷泡沫、冲洗等主要清洗步骤 |
| `detail` | 轮毂、玻璃、内饰和缝隙等局部处理 |
| `result` | 清洁完成、干净透亮或前后效果 |
| `offer` | 价格、折扣、套餐和新客体验 |
| `cta` | 点击导航、下单、联系或到店体验 |
| `transition` | 承上启下且没有更明确叙事作用的素材 |

修改后，`marketingRole` 的唯一含义是“素材在最终广告中的主要叙事作用”，不再表示画面里正在执行的具体动作。

## 4. 目标工作流

```text
上传 N 条素材
    ↓
媒体检测 N/N
    ↓
┌────────────────────┬────────────────────┐
│ 音频提取与 ASR N/N  │ 联系表与视觉分析 N/N │
└────────────────────┴────────────────────┘
    ↓ 等全部素材完成
整理素材结论（asset_understanding）
    ↓
整批 MarketingRole 判断：一次模型调用
    ↓
生成并持久化 N 条最终 AssetAnalysis
    ↓
智能编排
    ↓
finalClipOrder
    ↓
时间线、字幕、无字幕成片和带字幕成片
```

不增加新的前端流程节点。现有“整理素材结论”步骤承载整批角色判断；媒体检测至视觉分析仍显示批量进度，角色判断和智能编排仍属于整批素材完成后执行的任务。

## 5. 数据合同设计

### 5.1 视觉分析结果

视觉模型只输出客观画面证据，不再决定最终 `marketingRole`：

```json
{
  "assetId": "asset_xxx",
  "visualSummary": "工作人员使用吸尘设备清洁汽车内饰",
  "people": ["一名工作人员"],
  "objects": ["吸尘管", "汽车内饰"],
  "actions": ["使用吸尘设备清洁内饰"],
  "scenes": ["汽车内部清洁作业"],
  "screenTexts": [],
  "chronologicalHints": ["画面持续展示车内吸尘"],
  "confidence": 0.95,
  "needsDetail": false
}
```

从新版本的 `AssetVisualAnalysis` 必填字段中移除最终 `marketingRole`。历史检查点若包含该额外字段，应继续允许读取；不得要求迁移或重写历史版本。

### 5.2 整批判断输入

新增版本化输入合同 `auto-video-marketing-role-batch-input.v1`：

```json
{
  "schema": "auto-video-marketing-role-batch-input.v1",
  "projectId": "project_xxx",
  "assets": [
    {
      "assetId": "asset_1",
      "durationMs": 4000,
      "transcript": "你的车多久没有彻底洗过了？",
      "visualSummary": "工作人员向车辆喷洒清洁液",
      "actions": ["喷洒清洁液"],
      "scenes": ["洗车工位"],
      "screenTexts": [],
      "chronologicalHints": []
    }
  ],
  "userInstruction": "请依据内容自然衔接全部素材"
}
```

约束：

- 输入必须包含当前版本全部有效素材。
- `transcript` 为空字符串表示静音或无有效语音。
- 不发送原始音频、原始视频或本地文件路径。
- 不发送旧视觉角色，避免模型被旧结论锚定。
- 视觉模型生成的客观字段必须完整保留，不能用转写改写画面事实。

### 5.3 整批判断输出

新增输出合同：

```json
{
  "projectId": "project_xxx",
  "assets": [
    {
      "assetId": "asset_1",
      "marketingRole": "hook",
      "roleReason": "口播通过提问吸引车主注意，适合作为广告开场"
    }
  ]
}
```

模型输出中的 `roleReason` 必填；持久化的历史兼容 Schema 可将其定义为可选字段，以保证旧版本正常读取。

最终 `AssetAnalysis` 示例：

```json
{
  "assetId": "asset_1",
  "marketingRole": "hook",
  "audioSummary": "你的车多久没有彻底洗过了？",
  "visualSummary": "工作人员向车辆喷洒清洁液",
  "combinedSummary": "以车辆清洗画面配合提问式开场",
  "roleReason": "口播通过提问吸引车主注意",
  "topics": [],
  "people": [],
  "scenes": [],
  "screenTexts": [],
  "chronologicalHints": [],
  "duplicateWithAssetIds": [],
  "confidence": 0.95
}
```

## 6. 整批角色判断提示词

新增 `marketingRoleBatchInstructions`，核心内容如下：

```text
你是洗车营销短视频的整批素材作用判断模块。

你会收到同一项目全部素材的真实 ASR 口播、客观画面分析、
画面内文字、时长和用户要求。请为每条素材判断它在最终广告
叙事中的主要作用。

marketingRole 必须且只能是：
hook、problem、service、process、detail、result、offer、
cta、transition 中的一项。

判断原则：

1. 有有效口播时，以口播表达的营销意图作为 marketingRole
   的主要判断依据。

2. visualSummary、actions、scenes、screenTexts 和
   chronologicalHints 用于理解画面实际内容、辅助判断以及
   检查关键事实冲突。

3. 不要因为画面没有逐字对应口播，就改变口播承担的广告作用。
   洗车过程中的喷泡沫、冲洗、刷轮毂、吸尘、擦玻璃和抛光画面，
   可以作为其他洗车口播的普通 B-roll。

4. 按以下语义判断作用：
   - 提问、利益点、吸引注意：hook
   - 用户痛点、污渍或难清理问题：problem
   - 服务范围、项目和标准介绍：service
   - 清洗步骤和主要操作过程：process
   - 轮毂、玻璃、内饰、缝隙等局部处理：detail
   - 清洁完成、干净透亮、前后效果：result
   - 价格、折扣、套餐、新客体验：offer
   - 点击导航、下单、联系、到店体验：cta
   - 承上启下且没有更明确作用：transition

5. 没有有效口播时，根据客观画面、画面内文字和整批上下文判断。
   信息仍不足时使用 transition。

6. 价格、优惠、门店、服务承诺或清洁效果发生明确音画冲突时，
   不得编造一致性，必须在 roleReason 中说明。但只要不涉及关键
   事实，普通洗车动作不一致不影响口播作用判断。

7. 不得为了覆盖九种标签而强行分配角色。多个素材可以具有相同
   marketingRole。

8. 必须为输入中的每个 assetId 返回且只返回一条结果。
   不得遗漏、重复、修改或引入其他 assetId。

只返回严格 JSON，不使用 Markdown。
```

## 7. 编排提示词修改

现有编排提示词应从“画面优先”调整为“口播叙事优先、画面衔接辅助”：

```text
你是洗车营销短视频自动编排模块。

输入中的 marketingRole 已由整批素材结论模块结合真实 ASR
与客观画面分析确定。请将 marketingRole 作为每条素材广告作用
的主要事实，不要重新按可见动作覆盖它。

编排主要依据：

1. marketingRole、roleReason、audioSummary 和用户要求，
   用于建立广告叙事结构。

2. visualSummary、people、scenes、screenTexts 和
   chronologicalHints，用于安排同类素材的视觉衔接和时间顺序。

3. 普通音画动作不完全一致可以作为洗车服务 B-roll 使用，
   不应因此把 hook、service、result、offer 或 cta 改成 process。

4. 涉及价格、优惠、门店、服务承诺或清洁效果的明确冲突，
   必须在 clips.reason 中说明，不得把冲突内容描述成一致。

优先形成：
吸引注意 → 问题/服务 → 清洗过程 → 细节 → 效果 → 优惠 → 行动引导。

这只是结构方向，不要求每种角色必须存在，也不要求相同角色只能
出现一次。

第一版必须使用全部有效素材，每个素材恰好一次。
excludedAssets 必须为空。
```

排序理由应先说明口播叙事作用，再说明画面如何衔接。例如：

```json
{
  "assetId": "asset_cta",
  "order": 11,
  "reason": "口播明确引导用户点击导航并到店，应作为结尾 CTA；汽车清洁近景继续维持洗车服务的视觉氛围。"
}
```

## 8. 服务端修改范围

### 8.1 `src/shared/auto-video-contracts.ts`

- 从新视觉响应合同中移除最终 `marketingRole`。
- 新增整批角色判断输入、输出 Zod Schema。
- `AssetAnalysis` 继续保留 `marketingRole`。
- 增加历史兼容的可选 `roleReason`。
- 保证历史版本缺少 `roleReason` 时仍可正常读取。

### 8.2 `src/server/auto-video-ai.ts`

- 更新 `assetVisualInstructions`，只要求客观画面分析。
- 更新视觉响应格式和解析。
- 新增 `assignMarketingRolesBatch(...)`。
- 新增整批角色判断提示词。
- 修改 `toAssetAnalysis`，由整批判断结果提供最终角色，不再复制视觉角色。
- 修改 `planningInstructions` 为口播叙事优先。
- 模型对话来源记录为 `auto-video.marketing-role-batch`，便于审计。

### 8.3 `src/server/auto-video-worker.ts`

把当前流程：

```text
visual analysis → toAssetAnalysis → planning
```

改为：

```text
等待全部 ASR 和视觉分析完成
→ 构造整批角色输入
→ assignMarketingRolesBatch
→ 校验角色结果
→ 生成并持久化 AssetAnalysis[]
→ planning
```

现有 `asset_understanding` 步骤承载整批模型调用。角色判断完成后立即保存结果；恢复任务时，如果当前版本已经保存完整、合法、集合一致的 `assetAnalyses`，直接复用，不重复调用模型。

### 8.4 `src/server/auto-video.test.ts`

增加批量输入、输出校验、口播优先、失败恢复和编排提示词测试。

### 8.5 文档

同步更新：

- `docs/auto-video-orchestrator.md`
- 项目 `README.md`
- 根目录 `README.md`
- 真实链路回归报告

## 9. 校验、错误与恢复

设当前版本有效素材集合为 `expectedAssetIds`，模型返回后必须确定性验证：

```text
result.assets.length === expectedAssetIds.length
每个 assetId 属于当前项目
每个 assetId 恰好出现一次
没有遗漏、重复或未知 ID
marketingRole 属于九类枚举
roleReason 非空
```

校验失败使用明确错误，例如 `MARKETING_ROLE_ASSIGNMENT_INVALID`，并在详情中保留具体原因：

```text
missing assetId
duplicate assetId
unknown assetId
invalid marketingRole
empty roleReason
```

模型输出不合法时允许受控修复，最多三次；修复请求必须包含上一次的具体校验错误。

模型已经连接但调用失败时，不得静默使用旧视觉角色，否则会恢复本方案要修复的行为。瞬态故障使用项目现有服务恢复机制，并保留原始 `code`、`message`、阶段和可重试语义。

没有 Relay 的明确本地模式可以使用现有确定性降级，但必须在 `roleReason` 中注明使用了本地降级，不能伪装成模型综合判断结果。

## 10. 自动化测试

### 10.1 批量调用

- 同一生成版本只进行一次整批角色判断调用。
- 请求包含全部有效素材且每个恰好一次。
- 请求包含真实 ASR、视觉总结和画面文字。
- 请求不包含其他项目素材、原始媒体或本地文件路径。

### 10.2 角色场景

使用模拟模型响应验证数据流和持久化：

```text
提问口播 + 喷水画面 → hook
服务介绍口播 + 冲洗画面 → service
效果口播 + 抛光画面 → result
优惠口播 + 普通车身画面 → offer
导航口播 + 普通洗车画面 → cta
静音 + 挡风玻璃水流 → problem 或 transition
冲洗口播 + 吸尘画面 → process
```

单元测试不依赖真实模型自行推理；重点验证请求、严格响应合同、合并逻辑与最终持久化。

### 10.3 集合不变量

模拟以下非法输出并要求失败：

- 缺少一个素材 ID；
- 重复一个素材 ID；
- 返回不存在或其他项目的素材 ID；
- 返回非法角色；
- 返回空 `roleReason`。

输出数组顺序与输入不同但集合完整时应允许，因为角色结果数组不承担播放顺序。

### 10.4 编排输入

确认编排模型收到最终 `marketingRole`、`roleReason`、`audioSummary` 和 `visualSummary`。确认编排提示词不再包含“冲突时以画面为准”或“转写不得推翻画面行为”等旧规则。

### 10.5 恢复与兼容

- 已保存完整角色结果时，重启不重复调用角色模型。
- 角色判断完成但编排未完成时，从编排阶段继续。
- 批量角色调用失败时，不重复执行已完成的 ASR 和视觉分析。
- 取消任务时终止批量调用。
- 历史版本没有 `roleReason` 时仍可读取和播放。
- `finalClipOrder.length === N`，每个有效素材恰好出现一次，`excludedAssets` 为空。

## 11. 真实回归测试

完成自动化测试和构建后，新建版本回归，不覆盖历史 V1。

### 11.1 主包预期

| 素材 | 预期角色 |
| --- | --- |
| `wc-main-01-hook` | `hook` |
| `wc-main-02-problem` | `problem` |
| `wc-main-03-service` | `service` |
| `wc-main-04-foam` | `process` |
| `wc-main-05-rinse` | `process` |
| `wc-main-06-wheel` | `detail` |
| `wc-main-07-interior` | `detail` |
| `wc-main-08-result` | `result` |
| `wc-main-09-transition` | `transition` |
| `wc-main-10-offer` | `offer` |
| `wc-main-11-cta` | `cta` |

不得把文件名或预期答案写入生产提示词。模型应根据真实口播、画面和上下文得出结果。

最终结构预期接近：

```text
hook
→ problem/service
→ process
→ detail
→ transition/result
→ offer
→ cta
```

这不是固定模板；仍需根据实际素材判断。无论顺序如何，11 条素材必须全部且各出现一次。

### 11.2 异常包重点

- 静音：根据画面和整批上下文判断角色，不报错。
- 音画冲突：角色以口播叙事意图为主，理由承认画面动作不同但可作为 B-roll。
- 低音量：只使用真实 ASR 结果，不编造未识别内容。
- 重复素材：两个不同素材 ID 分别返回角色并各进入排序一次。
- 长口播：批量角色判断不改变字幕时间和内容。
- 损坏文件：仍在上传阶段拒绝，不进入角色判断。

## 12. 验收标准

实施完成必须同时满足：

1. `marketingRole` 不再由视觉分析阶段最终决定。
2. 全部 ASR 与视觉分析完成后，只调用一次整批角色判断模型。
3. 批量输出包含当前版本全部且仅包含当前版本素材 ID，每个恰好一次。
4. 每个 `marketingRole` 严格属于现有九类标签。
5. 编排模型使用批量判断后的最终角色。
6. 批量判断和编排提示词均明确以口播意图为主。
7. 普通音画动作不一致不会覆盖 `hook`、`service`、`result`、`offer` 或 `cta`。
8. 无口播素材能根据画面和上下文降级判断。
9. 主包的提问、效果、优惠和到店口播不再全部被视觉动作标成 `process`。
10. `finalClipOrder` 继续满足全量、唯一和项目隔离不变量。
11. 历史版本无需迁移即可读取。
12. 完整测试和生产构建通过。
13. 保存真实回归的角色、最终顺序、模型对话和所有未通过项。

## 13. 推荐实施顺序

1. 修改视觉响应与整批角色 Schema。
2. 先编写素材集合校验和批量输入测试。
3. 实现 `assignMarketingRolesBatch`。
4. 接入现有 `asset_understanding` 阶段并持久化结果。
5. 修改编排提示词为口播叙事优先。
6. 增加恢复、错误和历史兼容测试。
7. 运行完整测试与生产构建。
8. 使用 11 条主包创建新版本回归。
9. 复测静音和音画冲突两个关键异常场景。
10. 保存真实结果并更新测试报告和修改日志。

## 14. 影响说明

本方案每个生成版本只增加一次批量模型调用，不增加前端步骤，也不扩充九类角色。新增调用会增加一次模型请求的延迟和成本，但比逐素材增加 N 次调用更可控，并能利用整批上下文准确区分 `hook`、`transition`、`result` 和 `cta`。

实施后只影响新生成版本；历史角色、顺序、时间线、字幕和成片保持不变。任何公共 Schema、提示词或 Worker 状态修改都必须同步测试和文档，不能形成视觉角色已移除但调用方仍依赖旧字段的半迁移状态。
