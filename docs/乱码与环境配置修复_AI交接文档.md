# 上线前中文乱码与环境配置失效修复：AI 交接文档

> 状态：待实施  
> 日期：2026-08-31  
> 优先级：P0（正式交付前必须完成）  
> 适用项目：`washcut-agent-demo`  
> 本文用途：交给后续 AI 或工程师直接实施；本文不代表问题已经修复。

## 1. 一句话任务

在不改变洗车视频编排业务逻辑、历史数据和原始媒体文件的前提下，修复源码中已经损坏的中文字符串，并保证项目 `.env` 中的数据目录、签名密钥和上传限制在任何业务模块读取配置之前生效。

## 2. 为什么必须修

当前存在两个独立问题：

1. 部分源码字符串已经是乱码。用户会看到无法理解的确认框、状态说明和错误消息；其中一处乱码还位于“用户是否要求按时间顺序编排”的正则表达式中，会直接影响业务判断。
2. 服务入口在静态导入全部业务模块之后才调用 `process.loadEnvFile()`。多个模块在导入阶段就把环境变量保存为文件级常量，所以 `.env` 中的目录、签名密钥和上传限制可能被忽略，程序转而使用默认值。

这两个问题都不应通过增加哈希、基线快照或额外发布门禁解决。它们需要直接修复文本和配置初始化顺序，并用自动化测试证明结果。

## 3. 已确认事实

### 3.1 源码中确实存在乱码

使用 UTF-8 读取文件后，以下三个运行时代码文件仍能找到明显乱码，因此不是终端显示问题：

- `src/server/index.ts`
  - `activeRelay()` 的环境连接名称。
  - 模型连接状态消息。
  - 自动视频项目、生成版本、素材、上传、模型 Key、任务等 API 的中文错误消息。
  - 全局错误处理中的默认消息。
- `src/client/AutoVideoApp.tsx`
  - 删除项目的确认文案。
  - 删除项目失败时的降级错误文案。
- `src/server/auto-video-worker.ts`
  - 判断用户要求是否包含“时间顺序 / 先后 / 顺序”的正则表达式。当前乱码正则无法可靠匹配正常中文要求，属于业务行为缺陷，不只是显示问题。

可复查的代表位置：

```text
src/server/index.ts:130
src/server/index.ts:304
src/server/index.ts:496 及后续多个 API 分支
src/client/AutoVideoApp.tsx:669
src/client/AutoVideoApp.tsx:678
src/server/auto-video-worker.ts:842
```

不要把上述行号当成固定合同。实施前应重新搜索整个运行时代码，因为前序未提交改动可能改变行号。

### 3.2 不是所有“终端里看到的乱码”都表示文件损坏

`docs/operations.md` 使用 Node.js 按 UTF-8 读取时内容正常。旧版 Windows PowerShell 的 `Get-Content` 可能按系统默认编码显示无 BOM 的 UTF-8 文件，从而在终端里看起来像乱码。

因此实施时必须遵守：

- 不得仅根据 PowerShell 输出判断文件已经损坏。
- 优先使用项目要求的 FastCtx 文件工具；不可用时使用明确指定 UTF-8 的读取方式，例如 Node.js `fs.readFileSync(path, 'utf8')`。
- 禁止对整个仓库执行 Latin-1、GBK、GB18030 与 UTF-8 之间的批量转码。
- 只修复经过 UTF-8 原文核实、确实已经损坏的字符串。

### 3.3 `.env` 当前加载得太晚

`src/server/index.ts` 先静态导入业务模块，随后才执行：

```ts
const localEnvironmentFile = path.join(process.cwd(), '.env');
if (existsSync(localEnvironmentFile)) process.loadEnvFile(localEnvironmentFile);
```

但下列模块在导入阶段已经读取环境变量并保存为常量：

| 文件 | 导入阶段读取的配置 | 失败影响 |
| --- | --- | --- |
| `src/server/auto-video-media.ts` | `DATA_ROOT`、`MEDIA_SIGNING_SECRET` | 自动视频文件可能写到错误目录；签名可能使用开发默认密钥 |
| `src/server/media.ts` | `DATA_ROOT`、`MEDIA_SIGNING_SECRET` | 旧媒体链路可能使用错误目录或默认签名密钥 |
| `src/server/video-analysis.ts` | `DATA_ROOT`、`VIDEO_IMPORT_MAX_BYTES`、`WEBHOOK_SIGNING_SECRET`、`MEDIA_SIGNING_SECRET`、`VIDEO_PART_SIZE_BYTES` | 分片目录、远程导入上限、Webhook 签名和分片大小可能忽略 `.env` |
| `src/server/store.ts` | 默认 `DATA_ROOT` | 未显式配置 `DATABASE_FILE` 时，SQLite 默认位置可能不符合 `.env` |

`KEY_ENCRYPTION_SECRET` 当前在 `KeyVault` 构造期间读取，通常晚于 `index.ts` 中的 `.env` 加载；修复为统一的启动顺序后仍应验证它没有退化。

## 4. 目标行为

修复完成后必须满足：

1. 用户界面、API 中文消息和 Worker 的中文关键词判断均为可读、准确的简体中文。
2. `.env` 在任何项目业务模块求值之前加载。
3. 模块不得在 `.env` 加载前缓存目录、签名密钥或上传限制。
4. 未配置 `.env` 时，本地开发模式仍按现有默认值启动；不得破坏当前双击启动器和 `pnpm dev`。
5. 已有 `.env`、SQLite 数据库、原始视频、生成版本和成片不得被改写或迁移。
6. 不改变 `clipId/assetId`、编排顺序、字幕、时间线、模型提示词和渲染行为。
7. 所有运行时错误继续保留原始 `code`、`message` 和 `retryable` 语义；修复中文时不得顺手把原始上游错误包装成泛化错误。

## 5. 非目标

本任务不处理以下事项：

- 不接入登录、JWT、OIDC 或新的租户权限系统。
- 不迁移到 Postgres、对象存储或分布式任务队列。
- 不修改 Docker 公网监听、域名、HTTPS 或 CORS。
- 不新增 `finalClipOrder` 合同。
- 不升级模型、Remotion、React、Node.js 或 Python 依赖。
- 不删除用户项目、历史版本、模型日志、原片或成片。
- 不对全仓库进行机械转码或大范围文案重写。

如果实施过程中发现上述范围的问题，只记录证据，不扩大本次修改。

## 6. 推荐实施顺序

### 第一步：保护当前工作区

1. 运行 `git status --short --branch`，确认当前存在的用户改动。
2. 只修改本任务明确涉及的文件，不覆盖或回退其他未提交改动。
3. 不使用 `git reset --hard`、`git checkout --` 或会丢失工作区内容的命令。

### 第二步：建立可靠的乱码清单

1. 使用 UTF-8 读取运行时代码。
2. 搜索具有明显乱码特征的字符串，例如 `鏈`、`褰`、`椤`、`锛`、`銆`、`鈥` 等，但必须人工核对每个命中；单个字符搜索可能误伤正常中文。
3. 按以下类型分类：
   - 用户可见 UI 文案；
   - API 错误消息；
   - 日志或审计标签；
   - 影响控制流的正则表达式、关键词或枚举值。
4. 根据函数、路由、错误码和附近正常文案恢复含义。无法可靠确认原文时，写一条简短、准确的新中文，不猜测营销表述。

特别要求：

- `auto-video-worker.ts` 的顺序识别至少应能匹配“时间顺序”“先后”“顺序”。建议恢复为语义清楚的正则，并新增测试。
- 删除项目确认框必须明确说明会删除原始视频、版本和成片且不可恢复。
- API 文案应与 HTTP 状态和错误码含义一致。例如 404 是未找到，409 是当前状态冲突，403 是无权限。
- 不修改既有错误码来配合新文案。

### 第三步：把 `.env` 加载移到业务模块之前

推荐采用独立启动引导文件，避免依赖静态 import 的隐含执行顺序：

1. 新建一个极小的 server bootstrap，例如 `src/server/bootstrap.ts`。
2. bootstrap 只负责定位并加载 `.env`，随后使用动态 `import()` 加载真正的服务入口。
3. 将 `package.json` 的 `dev:server` 和 `start` 指向 bootstrap。
4. 从原服务入口删除重复的 `.env` 加载逻辑，避免出现两个配置来源。

伪代码示意：

```ts
import {existsSync} from 'node:fs';
import path from 'node:path';

const envFile = path.join(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

await import('./index.js');
```

这只是推荐结构，不要求机械照抄。如果项目现状更适合拆分 `app.ts` 与 `bootstrap.ts`，可以采用等价实现，但必须用测试证明业务模块读取配置前 `.env` 已加载。

不要只把 `process.loadEnvFile()` 移到 `index.ts` 静态 import 列表的上方；ESM 静态 import 仍会在模块主体执行前求值，不能可靠解决问题。

### 第四步：增加最小回归测试

至少新增以下测试：

1. **中文顺序意图测试**：用户要求包含“按时间顺序排列”“注意先后顺序”时，Worker 的对应判断为真；无关文本不应误判。
2. **`.env` 启动顺序测试**：在隔离子进程或隔离临时目录中，仅通过 `.env` 设置非默认值，然后证明业务模块读取到这些值。至少覆盖：
   - `DATA_ROOT`；
   - `MEDIA_SIGNING_SECRET`；
   - `VIDEO_PART_SIZE_BYTES`。
3. 如果测试结构允许，再覆盖 `WEBHOOK_SIGNING_SECRET`、`VIDEO_IMPORT_MAX_BYTES` 和默认数据库路径。
4. 测试不得读取、写入或删除现有 `data` 目录；必须使用新建的临时目录和独立端口。

签名密钥测试不要在日志中输出真实密钥。可以使用测试专用值，验证“密钥 A 生成的签名不能由密钥 B 验证”。

### 第五步：人工冒烟检查

使用临时 `DATA_ROOT` 和临时数据库执行，不碰用户现有数据：

1. 启动前后端，确认健康接口可访问。
2. 打开项目页面，检查模型状态、项目创建、删除确认框和失败消息均为正常中文。
3. 上传一个不支持的文件，确认提示可读且文件未进入项目。
4. 创建一个临时项目后删除，确认确认文案和结果可读。
5. 如条件允许，用两段短视频跑一次本地模式，确认编排和渲染行为未改变。

## 7. 验收条件

以下条件必须全部满足：

- [ ] UTF-8 原文检查确认 `src/server/index.ts`、`src/client/AutoVideoApp.tsx`、`src/server/auto-video-worker.ts` 不再包含已知乱码字符串。
- [ ] 不存在为了“消除搜索结果”而改坏的正常中文、历史数据兼容字段或错误码。
- [ ] 中文顺序意图测试通过。
- [ ] `.env` 配置生效测试通过，并证明不是依赖父进程预先注入环境变量。
- [ ] `pnpm test` 全部通过。
- [ ] `pnpm build` 通过。
- [ ] `git diff --check` 无新增空白错误。
- [ ] 使用临时数据目录完成页面/API 冒烟检查。
- [ ] 现有用户数据库、原片、成片和模型文件未修改。
- [ ] 项目 `README.md` 和根目录 `README.md` 的修改日志顶部记录实际实施内容、原因、文件、验证和影响。

如果 Python、Docker、Qwen 或 Relay 因本机环境无法运行，必须明确写“未验证”，不得把 TypeScript 测试或构建描述成真实 AI 端到端成功。

## 8. 建议验证命令

在 `D:\短视频\washcut-agent-demo` 中执行：

```powershell
git status --short --branch
pnpm test
pnpm build
git diff --check
```

乱码搜索应使用 UTF-8 工具并人工复核。示例：

```powershell
node -e "const fs=require('fs'); for (const f of process.argv.slice(1)) { const s=fs.readFileSync(f,'utf8'); if (/鏈|褰|椤|锛|銆|鈥/.test(s)) console.log(f); }" src/server/index.ts src/server/auto-video-worker.ts src/client/AutoVideoApp.tsx
```

该正则只是排查线索，不是完整编码校验器，也不能作为批量替换依据。

## 9. 风险与回退

- 最大风险一：把仅仅“终端显示错误”的正常 UTF-8 文件再次转码。控制方法是始终按 UTF-8 读取原文，只逐条修改已确认字符串。
- 最大风险二：修复启动顺序后，程序开始真正使用 `.env` 中此前被忽略的目录或密钥，导致现有本地数据看起来“消失”。实施前必须检查现有 `.env` 的配置名称和路径，但不得在日志或交付内容中泄露密钥。若目录发生变化，先报告，不自动搬迁用户数据。
- 最大风险三：切换签名密钥会使旧的临时签名 URL 失效。数据库和媒体不会丢失，页面重新获取 URL 即可；不得为兼容旧 URL 保留不安全的开发默认密钥。
- 回退时只回退本任务代码，不删除任何数据目录。若改动了 bootstrap 和脚本，回退必须保持 `pnpm dev` 与 `pnpm start` 至少一个可用入口。

## 10. 实施完成后的 AI 交付格式

后续 AI 完成代码修改后，必须按以下格式报告：

1. 修复结果：哪些乱码和配置问题已经解决。
2. 修改文件：逐个文件说明改动原因。
3. 修改前后行为：普通用户会看到什么变化，`.env` 如何生效。
4. 技术说明：解释 TypeScript/Node.js、ESM 静态导入、动态 `import()`、Vite/tsx 启动脚本在本次修复中的作用。
5. 数据与兼容性：确认是否触碰数据库、原片、成片和历史版本。
6. 验证证据：列出实际运行的测试、构建、冒烟结果；未运行的项目必须说明。
7. 剩余风险：只列尚未解决且与本任务直接相关的风险。

## 11. 可直接交给下一个 AI 的任务提示

```text
请实施 docs/乱码与环境配置修复_AI交接文档.md 中的全部“必须”项。

先读取 AGENTS.md、该交接文档、相关源码和现有测试，再最小范围修改。保护当前未提交改动，不覆盖用户数据。重点修复三处运行时代码中的真实乱码，并通过独立 bootstrap 保证 .env 在所有业务模块求值前加载。不要批量转码，不要扩展到认证、数据库迁移、Docker 公网部署或 finalClipOrder。

完成后运行 pnpm test、pnpm build、git diff --check，并使用临时 DATA_ROOT 做不触碰现有数据的冒烟验证。按 AGENTS.md 要求更新项目和根目录 README 修改日志，提供面向初学者的代码路径、数据流、技术栈和验证说明。无法验证真实 Qwen/Relay 时必须明确说明。
```

