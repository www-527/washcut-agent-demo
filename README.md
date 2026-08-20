# AI 视频编排系统

这是一个本地可运行的“完整原片自动编排”工作台。用户创建项目并一次上传多个视频后，系统会保留每个原始文件不变，分别进行语音转写和截图理解，再由模型根据**画面行为优先、画面内文字其次、转写文本仅辅助**的证据顺序确定唯一播放顺序。Remotion 依据经过校验的时间线完整拼接每段原片，输出一份不烧录字幕的 MP4；Caption JSON 与 WebVTT 始终作为独立产物生成。

## 修改日志
- 2026-08-20：为首次 GitHub 发布补充运行数据忽略规则，排除 `data/` 下的上传视频、生成成片与本地密钥，避免将用户素材、运行产物或敏感信息提交到远端。涉及 `.gitignore`、`README.md`。验证方式为 Git 暂存清单审查。影响：克隆项目后需由应用在本地创建运行数据目录；源码、示例配置与可商用演示素材仍可获取。

- 2026-08-20：移除成片预览中的“下载 WebVTT”按钮。字幕文件仍供网页预览按时间显示使用，但不再作为面向用户的下载项。涉及 `src/client/components/OutputPreview.tsx`、项目与根目录 `README.md`。验证方式为 TypeScript/Vite 生产构建。影响：MP4 下载与字幕开关保持不变，后端生成的 VTT 兼容产物不受影响。

- 2026-08-20：修复字幕将整段口播一次性展示与全屏重复显示的问题。生成时优先按 `words[].startMs/endMs` 分组成短字幕，单条最多 14 字或 1.8 秒，长停顿和句末提前切换；预览中的原生 VTT 轨道设为 `disabled`，只保留网页受控字幕层。涉及 `src/server/auto-video-captions.ts`、`src/server/auto-video.test.ts`、`src/client/components/OutputPreview.tsx`、项目与根目录 `README.md`。验证方式为词级字幕分组回归测试、完整 TypeScript 测试和生产构建。影响：新生成版本使用精细时间戳字幕；无词级时间戳的旧/降级转写仍按段落显示。

- 2026-08-20：将非全屏播放器的网页字幕位置同步上移至与全屏一致的下部阅读安全区，使用 `clamp(82px, 20cqw, 140px)` 随播放器宽度调整；全屏位置保持不变。涉及 `src/client/styles.css`、项目与根目录 `README.md`。验证方式为 TypeScript/Vite 生产构建。影响：普通预览字幕不再停留在旧的 52px 底部位置。

- 2026-08-20：根据参考画面进一步上移播放器容器全屏字幕，改为距底部 `clamp(160px, 26vh, 300px)`。涉及 `src/client/styles.css`、项目与根目录 `README.md`。验证方式为 TypeScript/Vite 生产构建。影响：仅进一步上移全屏网页字幕。

- 2026-08-20：将播放器容器全屏时的网页字幕上移至参考图的下部安全区，距底部使用 `clamp(118px, 19vh, 220px)`，避免与全屏控制栏重叠并让字幕落在人物/主体下方。涉及 `src/client/styles.css`、项目与根目录 `README.md`。验证方式为 TypeScript/Vite 生产构建。影响：仅调整全屏字幕垂直位置。

- 2026-08-20：将成片预览的全屏入口改为播放器容器全屏，确保网页自绘字幕与视频属于同一全屏元素；以自定义播放、进度、时长与全屏控制栏替代会让视频单独全屏的原生 controls。双击画面或点击全屏按钮均可切换。涉及 `src/client/components/OutputPreview.tsx`、`src/client/styles.css`、项目与根目录 `README.md`。验证方式为 TypeScript/Vite 生产构建。影响：全屏时字幕不再依赖各浏览器不一致的原生 VTT 呈现；MP4、WebVTT、字幕开关和时间线不变。

- 2026-08-20：补强原生全屏字幕轨道的触发条件。除了标准 `fullscreenchange`，现在也监听视频元素的全屏事件与 WebKit 的开始/结束全屏事件；全屏目标为视频自身或包含该视频的容器时均切换 WebVTT 轨道为 `showing`。涉及 `src/client/components/OutputPreview.tsx`、项目与根目录 `README.md`。验证方式为 TypeScript/Vite 生产构建。影响：修复浏览器原生播放器全屏路径不符合 `document.fullscreenElement === video` 时字幕仍不显示的问题。

- 2026-08-20：将网页预览与原生全屏字幕由上一版过大的展示比例下调为参考图的轻量字幕比例：网页层为 16–27px，原生全屏轨道为视口高度的 2.5%，同时保持白字、黑描边和无背景卡片。涉及 `src/client/styles.css`、项目与根目录 `README.md`。验证方式为 TypeScript/Vite 生产构建。影响：只调整字幕视觉密度，不改变字幕开关、全屏轨道切换、VTT 或 MP4。

- 2026-08-20：修复网页预览字幕在原生全屏时消失，并按播放器容器放大字幕。普通预览改为基于容器宽度的 30–58px 大号字幕；进入视频原生全屏时，临时显示同一 WebVTT 轨道并通过 `::cue` 应用白字、黑描边和阴影，退出全屏后恢复网页自绘字幕。涉及 `src/client/components/OutputPreview.tsx`、`src/client/styles.css`、项目与根目录 `README.md`。验证方式为 TypeScript/Vite 生产构建。影响：字幕开关、VTT 与 MP4 产物不变；全屏字幕不再依赖无法进入原生全屏容器的网页叠层。

- 2026-08-20：调整网页成片预览字幕为参考短视频样式：底部居中、大号白字、粗黑描边与轻微投影，移除半透明深色字幕卡片。涉及 `src/client/styles.css`、项目与根目录 `README.md`。验证方式为 TypeScript/Vite 生产构建。影响：仅改变网页预览时的字幕视觉效果，不改变原始 MP4、WebVTT 文件、字幕时间或“不烧录字幕”的成片约束。

- 2026-08-20：修复联系表视觉理解实际发送的系统指令错误。视觉分析继续使用普通图片输入并不发送 `text.format/json_schema`，但现在将 `auto-video.asset-visual-summary`、单截图和精查的业务提示作为 Responses API 的 `instructions` 字段发送；不再错误地套用“验证中转站连接”的测试助手指令。涉及 `src/server/auto-video-ai.ts`、`src/server/auto-video.test.ts`、项目与根目录 `README.md`。验证方式为联系表视觉请求体回归测试、TypeScript 测试和生产构建。影响：模型对话记录显示的系统指令与实际洗车素材理解任务一致。

- 2026-08-20：修复转文字模型切换仍依赖用户手工设置 TTL 的问题。Whisper 保持 Speaches 首次转写按需加载，切换离开时由程序调用 `/api/ps/{modelId}` 显式卸载，并与 `/api/ps` 状态轮询并行；只有确认目标模型不再处于已加载列表才允许启动 Qwen。项目管理的 Speaches 容器同时设置兼容 0.1.x 的 `WHISPER__TTL=0` 与新版的 `STT_MODEL_TTL=0`，启动脚本自动执行 `docker compose up -d speaches`，用户无需手改环境变量。模型尚未安装时仍使用既有下载接口。涉及 `src/server/speaches.ts`、`src/server/speaches.test.ts`、`.env`、`.env.example`、`docker-compose.yml`、`启动洗车片场Demo.cmd`、项目与根目录 `README.md`。验证方式为 Speaches/Registry 定向测试、完整 TypeScript 测试、生产构建、Compose 配置检查和本机 Speaches 实际切换检查。影响：网页可直接切换 Whisper 与 Qwen；卸载状态不能确认时保留原始错误并停止，不会同时加载第二个模型。

- 2026-08-20：新增全局“转文字模型”互斥切换按钮和模型生命周期合同；Whisper 与 Qwen 只能启用一个，运行中的视频任务禁止切换，生成版本必须使用当前已启用的转写模型。Qwen 网关健康检查改为无副作用，新增显式加载/卸载接口、推理锁、Python/模型引用清理、CUDA 缓存清理和显存归零确认；Speaches 侧强制要求 `STT_MODEL_TTL=0`，否则拒绝切换到另一模型。涉及 `src/shared/auto-video-contracts.ts`、`src/server/transcription-provider.ts`、`src/server/transcription-registry.ts`、`src/server/speaches.ts`、`src/server/qwen3-asr.ts`、`src/server/index.ts`、`src/server/store.ts`、`src/server/qwen3-asr.test.ts`、`src/server/transcription-registry.test.ts`、`src/client/auto-video-api.ts`、`src/client/AutoVideoApp.tsx`、`src/client/styles.css`、`qwen3-asr-gateway/app.py`、`qwen3-asr-gateway/test_app.py`、`qwen3-asr-gateway/README.md`、`.env`、`.env.example`、`docker-compose.yml`、项目与根目录 `README.md`。验证方式为 56 项 TypeScript 测试、TypeScript/Vite 生产构建、5 项 Python 测试、Python 语法检查、桌面与 390×844 移动端浏览器交互及控制台检查，以及真实 CUDA 加载/卸载；Qwen 加载后为 5,160,450,048 字节 allocated / 5,179,965,440 字节 reserved，卸载后均为 0 且 `gpuMemoryReleased=true`。影响：模型切换失败或无法确认显存释放时不会启动另一个模型；现有生成版本快照仍保留原模型信息，所有测试服务结束后均已关闭。

- 2026-08-20：完成修复后的 Qwen ForcedAligner 真实重测、主应用 HTTP Provider 合同验证及 17 段真实洗车口播 A/B。17/17 段 Qwen 转写成功且 17/17 段时间戳有效，逐段推理与对齐累计约 18.1 秒；新增 `docs/qwen3-asr-real-material-ab-2026-08-20.md` 并更新实施计划状态。涉及该评测报告、`docs/qwen3-asr-switchable-transcription-plan.md`、项目与根目录 `README.md`；验证方式为真实 CUDA 模型加载、ASR/ForcedAligner、TypeScript `Qwen3AsrTranscriptionProvider` multipart 调用、TypeScript 类型检查、54 项项目测试、2 项 Python 回归测试、Python 语法检查、生产构建及进程终态检查。影响：Qwen 本地链路已证明可用，但因缺少人工参考稿，Whisper 继续作为默认值；8010 无遗留监听，显存已释放。

- 2026-08-20：真实 Qwen 冒烟测试确认 ASR 可准确输出中文测试句，但发现 `qwen-asr 0.0.6` 的 ForcedAligner 返回 `List[ForcedAlignResult]`，原网关误把单项结果要求为原生列表；网关现从官方 `ForcedAlignResult.items` 读取时间项，同时保留旧列表形状兼容，并新增两项回归测试。涉及 `qwen3-asr-gateway/app.py`、`qwen3-asr-gateway/test_app.py`、项目与根目录 `README.md`；验证方式为模型健康检查（ASR 与对齐器均 ready）、真实 ASR 成功、Python 语法检查和两项单元测试通过；修复后的真实 ForcedAligner 重测因 RootFlowAI 审批预扣余额不足而未执行。影响：不估算时间戳、不改变错误透传；官方 SDK 返回结构不再被误判为无效列表。

- 2026-08-20：完成本机 Qwen3-ASR 部署配置核对：两个完整模型快照位于 `D:\短视频\model` 的独立子目录，网关历史日志已确认 ASR 模型可加载并成功返回一次真实转写；主应用 `.env` 已接入本机 `127.0.0.1:8010` 网关，并同步更新实施计划状态。涉及 `.env`、`docs/qwen3-asr-switchable-transcription-plan.md`、`README.md` 与根目录 `README.md`；验证方式为模型文件清单、网关日志、类型检查、54 项测试和生产构建；影响：Qwen 按钮将在网关健康且 ASR/对齐模型 ID 匹配时可选，Whisper 仍为默认，不发生静默回退。真实 ForcedAligner 端到端和洗车素材 A/B 仍待验证。

- 2026-08-19: Added Qwen3-ASR private gateway adapter with official qwen-asr model loading, forced alignment, local-only binding, API-key validation, and structured error responses. Reason: complete the switchable transcription plan without placing model weights or credentials in the TypeScript app. Files: qwen3-asr-gateway/app.py, qwen3-asr-gateway/requirements.txt, qwen3-asr-gateway/.env.example, qwen3-asr-gateway/README.md. Verification: Python syntax compilation and existing TypeScript tests/build. Impact: Qwen remains disabled until two complete Qwen snapshots and a working Python runtime are configured.

- 2026-08-19：将编排结果素材列表改为桌面端双列紧凑布局，并对文件名与内容说明做省略处理，避免单列过长导致结果难以浏览。涉及 `src/client/styles.css`；验证方式为 `pnpm build`；影响：仅调整结果页展示密度，不改变素材顺序、数据合同或导出时间线。

- 2026-08-19：创建智能编排版本时可选择 1、2、3 或 4 路画面理解并发，默认 1 路；选择会保存在版本快照中，基础联系表理解和可选精查遵守同一版本级限制，服务进程仍将全部项目合计限制在 4 路视觉请求。涉及 `src/shared/auto-video-contracts.ts`、`src/server/index.ts`、`src/server/auto-video-worker.ts`、`src/client/AutoVideoApp.tsx`、`src/client/styles.css`、`src/server/auto-video.test.ts`；验证方式为 `pnpm test`（50 项通过）与 `pnpm build`（TypeScript/Vite 通过）；影响：已有版本维持串行兼容，新版本可在上游容量允许时提高批处理速度。

- 2026-08-18：新增独立的“启动字幕转写”按钮，以及 `/api/transcription/status` 和 `/api/transcription/start` 接口；按钮仅检查/启动 Speaches 模型，不创建视频版本。涉及 `src/server/speaches.ts`、`src/server/index.ts`、`src/client/auto-video-api.ts`、`src/client/AutoVideoApp.tsx`、`src/client/styles.css`、项目与根目录 `README.md`；验证方式为 `pnpm build`，并实测两个接口均返回 `Systran/faster-whisper-base` 已就绪；影响：用户可以先单独启动并确认字幕转写，再开始视频编排。

- 2026-08-18：兼容部分 OpenAI 兼容中转站在模型 JSON 回复开头插入零宽 Unicode 格式字符（如 `U+200B`）的情况；统一 JSON 解析入口仅移除开头连续的格式字符后解析，不接受 Markdown、自然语言前缀或其他损坏 JSON。涉及 `src/server/relay-client.ts`、`src/server/pipeline.test.ts`、`src/server/auto-video.test.ts`、`README.md`；验证方式为 JSON 解析单元测试、带零宽前缀的联系表视觉理解回归测试、`pnpm test` 与 `pnpm build`；影响：正常 JSON 保持不变，原先会误报“模型输出不是合法 JSON”的有效回复可继续进入既有 Zod 校验。
- 2026-08-18：提升“模型对话记录”弹窗的正文、JSON、筛选控件和记录列表字号，并相应增大行高、控件高度与内容区空间。涉及 `src/client/styles.css`、`README.md`；验证方式为 `pnpm build`；影响：仅改善本地对话记录的可读性，不改变日志内容、筛选或复制行为。

- 2026-08-18：将素材理解与编排的证据优先级固定为“画面行为 → 画面内文字 → 语音/字幕转写”：联系表视觉请求不再接收转写，素材综合说明先展示画面行为，编排理由必须基于可见动作。涉及 `src/server/auto-video-ai.ts`、`src/server/auto-video-worker.ts`、`src/client/AutoVideoApp.tsx`、`src/server/auto-video.test.ts`、项目与根目录 `README.md`；验证方式为 `pnpm test`（47 项通过）和 `pnpm build`（通过）；影响：转写仍用于独立字幕导出，并只在不与画面冲突时辅助排序，不改变全量、无重复原片拼接不变量。

- 2026-08-17：移除逐素材视觉理解和素材综合分析中的 `suggestedPosition`，避免单段素材的全局位置猜测把已成功的联系表理解误判为格式错误并触发视觉修复重试；本地无模型编排改为严格按上传顺序合成。读取旧生成版本、项目分析和视觉检查点时仅在内存中剥离遗留字段，继续保留原始历史 JSON。涉及 `src/shared/auto-video-contracts.ts`、`src/server/auto-video-ai.ts`、`src/server/store.ts`、`src/server/auto-video.test.ts`、`docs/remove-suggested-position-handoff.md`、`README.md`；验证方式为 `pnpm test`、`pnpm build` 及旧字段兼容读取回归测试；影响：新模型请求和保存结果不再包含该标签，真正的字段/JSON 校验失败仍走可诊断的修复与重试链路。
- 2026-08-17：新增《移除单素材 `suggestedPosition`：问题交接与实施规格》，交接“视觉理解成功但位置枚举不合法 → AI 修复请求 502 → 同一联系表循环重试”的根因、现有通信状态、目标数据合同、历史兼容策略和可验收实施范围。涉及 `docs/remove-suggested-position-handoff.md`、`README.md`；验证方式为人工核对已保存模型对话记录与当前 `AutoVideoAiProvider`/`AutoVideoWorker` 调用链；影响：仅新增后续重构依据，不改变当前运行逻辑。
- 2026-08-17：将自动生成中所有带图片的视觉理解（联系表基础理解、可选精查和旧版单截图理解）统一改为复用“模型对话测试”的普通多模态聊天传输：图片随用户消息发送、不传 `text.format/json_schema`；模型返回后继续由本地 JSON 解析、Zod 契约校验、归一化与既有修复流程把关。涉及 `src/server/relay-client.ts`、`src/server/auto-video-ai.ts`、`src/server/auto-video.test.ts`、`README.md`；验证方式为新增请求体回归测试、`pnpm test`（42 项通过）和 `pnpm build`（通过）；影响：兼容仅稳定支持普通图片对话的 OpenAI 兼容中转站，视觉请求不再依赖上游严格 Schema 能力。
- 2026-08-17：修复版本状态为 `failed` 但某个步骤仍遗留 `running` 时页面没有“中断任务”的卡住状态；此类历史不一致记录会继续轮询并允许中断，`needs_attention` 版本也显示“从已保存断点继续”。涉及 `src/client/AutoVideoApp.tsx`、`src/server/index.ts`、`src/server/store.ts`、`README.md`；验证方式为 `pnpm test`、`pnpm build` 和浏览器版本详情交互检查；影响：不改变正常终态的操作权限，只为可恢复的遗留运行标记提供停止与恢复入口。
- 2026-08-17：在浏览器开发者工具输出当前生成任务的结构化进度日志，包括版本状态、全局进度、当前步骤、重试时间和每素材检查点状态；相同状态不会重复输出。涉及 `src/client/AutoVideoApp.tsx`、`README.md`；验证方式为 `pnpm build` 与浏览器控制台检查；影响：仅增加本地浏览器可观测性，不改变任务调度或模型请求。
- 2026-08-17：将自动视觉任务的可恢复错误重试由指数退避改为固定 5 秒延迟；每次失败保存 `nextRetryAt = now + 5s`，不再加入随机抖动或延长等待。涉及 `src/server/auto-video-worker.ts`、`docs/resilient-visual-analysis-implementation.md`、`README.md`；验证方式为 `pnpm test` 与 `pnpm build`；影响：上游恢复后更快重试，但持续故障时的请求频率固定为每 5 秒一次。
- 2026-08-17：实施生成版本级视觉理解检查点与可中断持续重试：每个素材的转写、截图/联系表和基础视觉结果分别立即写入 SQLite；可恢复的 Relay/网关/网络错误以持久化的固定延迟进入 `retry_waiting`，服务重启后恢复定时任务；支持“中断任务”和从保留检查点继续，页面展示素材级完成数、失败素材和下次重试时间。涉及 `src/shared/auto-video-contracts.ts`、`src/server/store.ts`、`src/server/auto-video-worker.ts`、`src/server/auto-video-ai.ts`、`src/server/index.ts`、`src/client/AutoVideoApp.tsx`、`src/client/auto-video-api.ts`、`src/client/styles.css`、`src/server/auto-video.test.ts`；验证方式为 `pnpm test` 与 `pnpm build`；影响：已完成素材不会在同一生成版本的重试、取消、继续或服务恢复中重复发送给视觉模型，等待/中断任务保留恢复所需的检查点引用。
- 2026-08-17：新增《断点恢复、持续重试与可中断视觉理解：AI 实施规格》，规定将素材级视觉理解结果即时持久化、对可恢复上游错误执行可中断的持久化退避重试、服务重启恢复、从中断检查点继续及对应前端进度/控制状态。涉及 `docs/resilient-visual-analysis-implementation.md`、项目与根目录 `README.md`；验证方式为人工核对当前 Worker、API 与页面行为，未修改运行代码；影响：仅提供后续实施依据，不改变现有任务执行逻辑。
- 2026-08-17：当 Speaches 语音转写服务未配置、不可达或返回异常时，自动生成空转写并继续智能编排；处理流程中的“语音转写”步骤会明确显示“暂未启用”，不再因该可选能力反复重试或阻止任务创建。涉及 `src/server/index.ts`、`src/server/auto-video-worker.ts`、`src/server/speaches.ts`、`src/shared/auto-video-contracts.ts`、`src/client/AutoVideoApp.tsx`；验证方式为服务端测试、TypeScript/Vite 构建；影响：语音内容不参与素材理解和字幕生成，本地媒体读取与视觉模型错误仍会如实失败。
- 2026-08-17：修复模型连接窗口的重复请求与本地限流问题；将稳定的 `refreshConnection` 回调直接传给 `KeyManager`，避免父组件每次渲染创建新函数而反复触发 Key 列表 Effect。涉及 `src/client/AutoVideoApp.tsx`；验证方式为 TypeScript/Vite 构建；影响：打开、保存或删除模型连接不会再因重复刷新耗尽本地 API 请求额度。
- 2026-08-17：重做“对话测试”附件体验为图片缩略图卡片，支持预览、逐张移除、发送后在消息中保留图片缩略图，并在浏览器连接中断时显示可操作的中文诊断；开发代理会等待模型中转的受控重试，避免显示原始 `Failed to fetch`。涉及 `src/client/components/RelayChatTester.tsx`、`src/client/api.ts`、`src/client/styles.css`、`vite.config.ts`；验证方式为 TypeScript/Vite 构建、服务端 multipart 传输探针及浏览器附件交互验收；影响：不改变图片大小、数量和传输范围限制，改善失败可诊断性与图片确认体验。
- 2026-08-17：修复“对话测试”图片选择入口，改为原生标签触发文件选择，并支持将图片直接拖放到对话输入栏；附件区采用紧凑的 Codex 式拖放提示与标签。涉及 `src/client/components/RelayChatTester.tsx`、`src/client/components/Icons.tsx`、`src/client/styles.css`；验证方式为 TypeScript/Vite 构建、浏览器文件选择和拖放状态验收；影响：图片选择不再依赖脚本点击隐藏输入框，支持多次追加附件。
- 2026-08-17：为模型连接的“对话测试”加入 JPEG、PNG、WebP、GIF 图片附件；图片仅随当前消息以 Responses `input_image` 转发、按字节验证并在请求后删除临时文件，避免把图片内容写进对话日志。涉及 `src/client/components/RelayChatTester.tsx`、`src/client/api.ts`、`src/server/index.ts`、`src/server/media.ts`、`src/server/relay-client.ts`、`src/server/pipeline.test.ts`、`src/client/styles.css`；验证方式为服务端单元测试、TypeScript/Vite 构建及浏览器弹窗附件流程；影响：文本对话保持兼容，单次最多 10 张图片、单张 ≤15 MiB、合计 ≤60 MiB。

此前的“洗车片场”营销视频代码仍保留在仓库中，便于现有使用者继续访问其接口；浏览器入口已切换为新的自动视频编排界面，两条链路不共享会修改/代理转码原片的逻辑。

## 产品保证

- 原始视频一经保存即不可覆盖、裁切、转码、调色、降噪、变速或改写音轨。
- 平衡理解模式会在本地将早、中、晚三帧合成为一张带 A/B/C 时间标签的 JPEG 联系表，并且只向视觉模型发送这一张图片；等待自动重试或已中断的版本会保留恢复所需的受控临时产物，最终成功后才按清理策略删除。
- 无音轨视频得到空转写/空字幕，但仍可参与视觉理解和完整拼接。
- 编排模型不能读取原始音频或完整视频，也不能返回 JSX、Remotion 代码、Shell、路径或帧数。
- 每个有效素材必须恰好完整播放一次；时间线由程序而非模型计算，使用 contain、原音量 1 和直接切换。
- 成片唯一且不含硬字幕；预览窗的开关只切换当前 HTML5 TextTrack，不创建任何后台任务。

## 本地运行

~~~powershell
pnpm install
pnpm dev
~~~

打开 [http://127.0.0.1:5173/](http://127.0.0.1:5173/)。创建项目、上传 MP4/WebM/MOV，再点击“开始自动编排”。每个文件最大 250 MB，每个项目最多 20 个素材。

首次服务端渲染会由 Remotion 准备 Chrome；实际耗时取决于素材总时长、分辨率和本机性能。

## 转写与模型配置

开发模式下（默认 DEMO_MODE=true），未配置服务时系统仍会真实探测、截图、编排和渲染，但转写采用明确标记的空结果、视觉/编排采用确定性本地降级。因此它适合验证完整链路，不能替代真实语言或视觉理解。

要处理真实语音，把 DEMO_MODE=false 并配置独立 Speaches 服务和兼容 Responses API 的视觉/编排中转：

~~~env
SPEACHES_BASE_URL=http://speaches:8000/v1
SPEACHES_API_KEY=replace-with-private-key
SPEACHES_MODEL=Systran/faster-whisper-large-v3
SPEACHES_TIMEOUT_MS=600000
SPEACHES_MAX_RETRIES=2

RELAY_BASE_URL=https://relay.example.com/v1
RELAY_API_KEY=
RELAY_MODEL=gpt-5
~~~

Whisper 由 Speaches 在首次转写时按需加载；主应用在切换离开 Whisper 时调用 `/api/ps/{modelId}` 显式卸载。项目管理的 Speaches 服务同时设置 `WHISPER__TTL=0`（兼容当前 0.1.x 镜像）和 `STT_MODEL_TTL=0`（兼容新版），每次转写结束即释放 Whisper，启动脚本会自动确保该服务配置生效。卸载请求与状态轮询并行，确认该模型不再处于 `/api/ps` 已加载列表后才启动 Qwen；这是 Speaches 进程状态确认，不是 CUDA 字节级遥测。Qwen 网关健康检查不会加载模型，只有点击“启用”才加载 ASR 与 ForcedAligner；切换离开 Qwen 时，主应用必须收到显存分配量和保留量均为 0 的确认，否则拒绝启动另一个转写模型。运行中的视频版本会阻止模型切换。

Speaches 请求使用 verbose_json、词级与段级时间戳、中文语言参数和零温度；秒级时间戳会被立即标准化为毫秒。模型的所有结构化输出都经过 Zod 契约校验，非法编排最多自动修复两次。

完整的组件边界、API、存储策略和运行排错说明见 [docs/auto-video-orchestrator.md](docs/auto-video-orchestrator.md)。

## 验证

~~~powershell
pnpm test
pnpm build
~~~

测试覆盖 Speaches 时间戳标准化、空音轨、Caption/VTT、时间线连续性、重复/遗漏编排拒绝和截图采样策略。运行应用后还应至少用两段真实短视频完成一次项目级渲染；在未配置 Speaches/Relay 的开发模式中，这会验证本地降级编排与 Remotion 输出链路。

## 其他文档

- 2026-08-19: Added version-scoped switchable Whisper large-v3 and Qwen3-ASR-1.7B transcription. Qwen can be selected only when both the ASR and ForcedAligner are healthy with matching model IDs; it requires real alignment timestamps and never silently falls back to Whisper. Added provider status API, private gateway contract, version snapshots, raw transcription audit artifacts, and unavailable-reason UI. Files: `src/shared/auto-video-contracts.ts`, `src/server/transcription-provider.ts`, `src/server/speaches.ts`, `src/server/qwen3-asr.ts`, `src/server/transcription-registry.ts`, `src/server/auto-video-worker.ts`, `src/server/index.ts`, `src/client/auto-video-api.ts`, `src/client/AutoVideoApp.tsx`, `src/client/styles.css`, `.env.example`, `docker-compose.yml`, `docs/qwen3-asr-gateway.md`, `src/server/qwen3-asr.test.ts`. Reason: enable traceable A/B evaluation for Chinese car-wash speech, noise, and domain vocabulary. Verification: `pnpm.cmd exec tsc --noEmit`, `pnpm.cmd test` (54 passed), and `pnpm.cmd build` (TypeScript/Vite passed). Impact: Whisper remains default; Qwen is disabled while its gateway is unavailable or unhealthy; legacy generations retain Whisper compatibility. Real Qwen model/GPU/car-wash-material E2E validation has not run.

- [自动视频编排实现说明](docs/auto-video-orchestrator.md)
- [断点恢复、持续重试与可中断视觉理解：AI 实施规格](docs/resilient-visual-analysis-implementation.md)
- [旧营销视频链路的统一传输合同](docs/transport-contract.md)
- [旧视频分析 API](docs/video-analysis-api.md)
- [部署与故障处理基线](docs/operations.md)

