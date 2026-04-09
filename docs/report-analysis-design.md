# VibeGPS Report Analysis 设计说明

## 1. 目标

VibeGPS 的核心不是“再做一个 diff 页面”，而是让用户在持续 vibecoding 之后，重新获得对项目演化过程的掌控感。

因此我们把能力拆成两层：

- `delta`：事实层。每个 turn 结束后稳定生成，记录这一次到底改了什么。
- `report`：解释层。不是每轮都做，而是在“值得看”的时候，对一段累计演化窗口进行解释、评估与可视化表达。

一句话概括：

> delta 负责记账，report 负责复盘。

## 2. 为什么不能只给用户 diff

直接 diff 只能回答“哪里变了”，回答不了下面这些更关键的问题：

- 这一阶段 agent 到底在推进什么目标？
- 这些改动会影响哪个模块、哪条链路、哪种维护成本？
- 用户现在应该先 review 哪几个文件？
- 当前实现和设计文档是一致、部分一致，还是已经开始漂移？

如果 report 不能回答这些问题，那它对用户的价值就和看 git diff 没有本质区别。

## 3. 双层模型

### 3.1 Delta 层

每个 turn 结束时生成一次 delta，内容包括：

- `fromCheckpointId` / `toCheckpointId`
- 改动文件列表
- 行级增删统计
- patch 引用
- prompt 片段预览

这一层强调稳定、低成本、全量留痕。

### 3.2 Report 层

report 不是针对单个 delta，而是针对一个累计窗口：

- 起点：`Init checkpoint` 或“上一次 report 的锚点”
- 终点：当前 checkpoint

它要输出的不是文件列表，而是：

- 阶段意图
- 关键变化
- 影响分析
- 风险提示
- 设计对齐判断
- 建议 review 顺序
- 下一步建议

## 4. Report 触发策略

report 不应该每轮都自动生成，否则：

- 会拖慢 vibecoding 体验
- 会产生大量低价值总结
- 会让用户反而忽略真正值得看的阶段

因此采用两种触发方式：

### 4.1 手动触发

用户显式执行：

```bash
vibegps report
```

适合用户在某个阶段主动想“收束上下文、恢复掌控”的时候使用。

### 4.2 阈值自动触发

系统按“自上次 report 以来的累计窗口”判断，而不是按单轮 delta 判断。

默认阈值：

- 触达文件数达到阈值
- 变更行数达到阈值

这意味着：

- 单轮小改动不会频繁打扰用户
- 多轮累计后，系统会在真正值得复盘的时候生成报告

## 5. Analyzer 设计

### 5.1 输入

analyzer 的输入不是裸 diff，而是一个结构化上下文：

- 当前 branch
- report window 的起止 checkpoint
- 聚合后的 delta 统计
- 时间线
- 重点 review 文件
- patch 摘要
- 项目上下文
- 设计文档上下文

### 5.2 输出

analyzer 输出 `ReportAnalysis`，核心字段包括：

- `headline`
- `overview`
- `intent`
- `keyChanges`
- `impact`
- `risks`
- `designAlignment`
- `reviewOrder`
- `nextQuestions`
- `confidence`

### 5.3 运行策略

优先使用本地 `codex exec` 驱动 analyzer：

- 好处：解释能力更强，能把 patch 和设计语义串起来
- 约束：需要本地 codex 可用，且会带来额外耗时

若 codex 不可用或执行失败，则回退到 heuristic analyzer：

- 保证能力可用
- 保证 report 不因 runtime 问题完全失效
- 但分析质量低于真实 agent runtime

## 6. HTML 展示原则

HTML 只是 report 的表现层，不是 report 本体。

展示信息结构应遵循：

1. 先告诉用户“为什么这份 report 值得看”
2. 再告诉用户“这一阶段 agent 大概在做什么”
3. 再告诉用户“有哪些关键变化、影响和风险”
4. 最后告诉用户“先 review 哪里、接下来问什么”

因此页面结构应优先展示：

- Headline / Overview
- 窗口级指标
- 阶段意图
- 关键变化
- 影响分析
- 风险与 review 顺序
- delta 时间线

## 7. 与当前实现对齐的关键原则

本轮优化后的实现应遵循以下约束：

- 每个 turn 只保证生成 delta，不强制每轮出 report
- report 基于累计窗口，而不是基于单轮 delta
- report 必须包含解释性内容，不能退化成纯 diff 页面
- analyzer 优先走 codex，本地失败时允许 heuristic 兜底
- 手动 report 与阈值 report 走同一套分析与渲染管线

## 8. 后续可继续增强的方向

- 引入真正的设计文档对齐评分，而不只是文本证据引用
- 引入“建议回滚入口”与“怀疑漂移点”
- 支持日报、周报、任意 checkpoint 区间 report
- 支持把 report 结果同步给 VS Code 插件前端而不是只落地 HTML
