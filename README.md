# VibeGPS

VibeGPS 是一个面向 vibecoding 的 CLI 追踪器。

它不会替代 `codex`，而是接在 `codex` 后面，持续记录项目在每一轮 AI 开发之后到底发生了什么变化，并在变化累计到值得 review 时生成高可视化报告。

一句话理解：

> `codex` 负责写，`vibegps` 负责记、负责解释、负责帮你重新获得掌控感。

## 当前 MVP 能做什么

- 一次 `init` 接入当前项目
- 接管 Codex turn-end hook
- 按 Git branch 维护独立追踪链`r`n- 新 branch 首次 diff 自动建立 branch baseline
- 每轮生成 `checkpoint + delta`
- 达到阈值时自动生成 report
- 手动生成 report
- 提供 `status` / `branches` / `ls` / `doctor` 诊断与查询命令
- 在项目内维护 `.vibegps/` 工作空间，在用户主目录维护全局项目索引

## 安装

### 1. 安装依赖

```bash
npm install
```

### 2. 构建

```bash
npm run build
```

### 3. 本地使用 CLI

```bash
node dist/bin.js --help
```

如果要全局安装当前包用于日常使用：

```bash
npm install -g .
```

安装后可直接使用：

```bash
vibegps --help
```

## 最短使用路径

在你的项目目录里：

```bash
vibegps init
codex
```

`vibegps init` 会做这些事：

1. 创建 `.vibegps/`
2. 写入项目级配置 `.vibegps/config.json`
3. 生成初始 checkpoint
4. 给当前 Git branch 创建 `BranchTrack`
5. 接入 `.codex/config.toml` 的 turn-end notify
6. 生成一个基础 `ProjectDigest`
7. 把当前项目写入全局索引 `~/.vibegps/projects.json`

之后你继续正常使用 `codex` 或 `codex resume` 即可。

每次 Codex 一轮完成后，VibeGPS 会自动：

1. 读取当前 branch
2. 找到该 branch 对应的追踪链
3. 生成新的 snapshot / checkpoint / delta
4. 判断累计变化是否达到 report 阈值
5. 若达到阈值，则自动生成 HTML/Markdown 报告

## 命令总览

### `vibegps init`

初始化当前项目，并接入 Codex hook。

```bash
vibegps init
```

### `vibegps diff`

手动生成一次 delta 和 checkpoint。

```bash
vibegps diff --manual
```

适合：

- 你想手动捕获当前工作区变化
- 你想验证 diff / report 链路是否正常

### `vibegps report`

对当前 branch track 手动生成一份 report。

```bash
vibegps report
```

### `vibegps status`

查看当前项目状态。

```bash
vibegps status
```

会显示：

- 当前 workspace
- 当前 branch
- 当前 branchTrack
- 最新 checkpoint
- 最新 report
- 项目摘要状态

### `vibegps branches`

列出当前项目内所有 branch tracks。

```bash
vibegps branches
```

### `vibegps ls`

列出所有接入过 VibeGPS 的项目。

```bash
vibegps ls
```

查看最近生成过的报告：

```bash
vibegps ls --reports
```

### `vibegps doctor`

快速诊断当前项目能否正常跑完整链路。

```bash
vibegps doctor
```

会检查：

- `git` 是否可用
- `codex` 是否可用
- 当前目录是否是 git repo
- `.vibegps/` 是否存在
- `.vibegps/config.json` 是否可解析
- `.vibegps/state.db` 是否可读
- hook shim 是否存在
- `.codex/config.toml` 是否存在受管 notify 配置
- `ProjectDigest` 是否可用

## 目录结构

初始化后，项目里会出现：

```text
.vibegps/
  config.json
  state.db
  checkpoints/
  deltas/
  reports/
  hooks/
  cache/
  logs/
  tmp/
```

其中：

- `checkpoints/`：每个阶段节点的快照信息
- `deltas/`：每一轮变更记录与 patch
- `reports/`：HTML / Markdown / JSON 报告
- `hooks/`：Codex hook shim
- `cache/project-digest.json`：项目整体摘要

用户主目录还会维护：

```text
~/.vibegps/
  projects.json
  recent-reports.json
```

如果你想把全局索引放到自定义目录，例如测试环境或临时环境，可以设置：

```bash
VIBEGPS_HOME=/your/custom/path
```

未设置时默认使用 `~/.vibegps/`。

## 报告怎么理解

VibeGPS 把信息分成两层：

### `delta`

事实层。

每轮都生成，用来回答：

- 这轮改了哪些文件
- 改了多少行
- patch 在哪里

### `report`

解释层。

不是每轮都生成，用来回答：

- 最近这段时间 AI 到底在推进什么
- 影响了哪些模块
- 有哪些风险
- 应该先 review 哪些文件
- 有没有偏离设计文档

## 当前推荐工作流

### 场景 1：开始接入一个新项目

```bash
cd your-project
vibegps init
codex
```

### 场景 2：看当前项目是否正常接入

```bash
vibegps doctor
vibegps status
```

### 场景 3：强制记录当前状态

```bash
vibegps diff --manual
```

### 场景 4：手动生成一份阶段报告

```bash
vibegps report
```

### 场景 5：查看本机所有接入项目

```bash
vibegps ls
```

## 当前已完成与未完成

### 已完成

- CLI 主链路
- 项目初始化
- Codex turn-end hook 接入
- branch-aware checkpoint / delta
- 阈值触发 report
- 手动 report
- report analyzer：Codex 优先，heuristic 兜底
- 项目摘要 `ProjectDigest`
- 全局项目索引
- `doctor` / `ls` / `status` / `branches`
- HTML / Markdown / JSON 报告产出

### 仍在后续阶段

- 真正可用的 VS Code 前端面板
- 日报 / 周报 / 任意 checkpoint 区间报告
- 多窗口 / 多 agent 来源归因
- Claude Code 正式适配
- 更强的设计文档对齐与项目级知识图谱

## 常见问题

### 1. `vibegps report` 为什么可能是空的？

说明当前 report window 内没有新的 delta。

先检查：

```bash
vibegps status
vibegps doctor
```

如果你预期应该有变化，可以先手动执行：

```bash
vibegps diff --manual
```

### 2. 报告为什么有时是 `heuristic`，有时是 `codex`？

当前策略是：

- 优先尝试 `codex` 结构化分析
- 如果 `codex` 不可用或输出不合法，则回退到 `heuristic`

### 3. 为什么 branch 切换后会有新的追踪链？

这是设计使然。

VibeGPS 的追踪单位不是整个仓库的一条线，而是：

```text
Workspace > BranchTrack > Checkpoint > Delta > Report
```

这样可以避免不同 branch 的 checkpoint 互相污染。

## 开发命令

```bash
npm run build
npm test
```

当前测试覆盖了这些 MVP 主链路：

- `init` 初始化与 hook 接入
- `delta` 的 line-aware patch 生成
- branch-aware report window 计算
- heuristic report 分析
- `ProjectDigest` 生成
- 全局项目索引写入与读取

## 许可证

MIT

