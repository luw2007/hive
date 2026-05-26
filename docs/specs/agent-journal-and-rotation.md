# Agent 航行日志与 Session 主动轮转设计

> 状态：Draft  
> 日期：2026-05-25  
> 前置依赖：`worker-handover-design.md`、`auto-resume-on-restart.md`、`unified-task-model.md`

---

## 1. 问题陈述

Hive 运行 2 天后暴露的上下文膨胀问题：

1. **Orchestrator**：作为中心枢纽反复接收 user input + worker reports，Claude Code 的 auto-compaction 丢失任务图认知和全局状态
2. **Worker**：串行执行多个 dispatch，前面任务的上下文对后续任务是噪音，无清理机制
3. **User-Orchestrator 无效沟通**：用户决策散落在长对话中无结构化记录，Orch 轮转后新 session 不知用户决策偏好，用户需反复纠正方向

核心矛盾：**agent 的 session 生命周期 = workspace 生命周期**，但合理的上下文窗口应该以**任务粒度**为单位。同时，用户的决策意图缺乏持久化载体，导致每次轮转或 compaction 后都需要重新建立共识。

## 2. 设计目标

| 目标 | 度量标准 |
|------|----------|
| Worker 上下文始终干净 | 每次新 dispatch 开始时，agent 上下文仅含：身份 + 最近航行摘要 + 新任务内容 |
| Orchestrator 不因 compact 丢失全局状态 | 轮转后 recovery 注入包含完整任务图 + 最近事件 |
| 所有通信全量可追溯 | 任何 send/report 的原文可通过文件路径找回 |
| 与现有机制协同非替代 | Handoff/Recovery/Checkpoint/Reminder Tail 全部保留不动 |
| 用户决策永不丢失 | 轮转后恢复注入自动包含 active decisions 完整列表 |

## 3. 与现有机制关系

本方案是**增量新增**，不替换任何现有机制：

| 现有机制 | 触发时机 | 本方案关系 |
|----------|----------|-----------|
| Recovery Summary | Agent 重启且无法 session resume | **被利用**：轮转后的恢复注入基于它 |
| Handoff Report | Worker 被删除 | **不动**：独立场景 |
| Auto-Resume | Hive runtime 重启 | **不动**：独立场景 |
| Task Events | Dispatch 生命周期 | **补充**：task_events 是任务维度，journal 是 agent 活动维度 |
| Checkpoint | Agent 主动保存进度 | **被利用**：orch 轮转前触发 checkpoint |
| Reminder Tail | 每条消息尾部 | **不动**：仍作为防遗忘锚点 |
| PROTOCOL.md | Workspace 打开时生成 | **不动**：仍作为 `cat` 恢复路径 |
| Decision Ledger | 用户做出决策/偏好时 | **新增**：董秘机制，结构化记录用户决策 |

## 4. 航行日志（Agent Journal）

### 4.1 存储结构

```
<workspace_path>/.hive/journal/
├── <agent-name>/
│   ├── manifest.jsonl           # 摘要索引（唤醒记忆）
│   └── entries/                 # 全文文件
│       ├── 0001-dispatch-received-a1b2c3.md
│       ├── 0002-report-sent-d4e5f6.md
│       └── 0003-session-rotated.md
└── <another-agent-name>/
    ├── manifest.jsonl
    └── entries/
```

### 4.2 Manifest Entry Schema

```typescript
interface JournalEntry {
  /** 递增序号，4 位零填充 */
  seq: number
  /** ISO 8601 时间戳 */
  ts: string
  /** 事件类型 */
  type: 'dispatch_received' | 'report_sent' | 'status_sent' | 'user_input_received' | 'session_rotated' | 'checkpoint_saved'
  /** 1-2 行摘要，用于唤醒记忆（≤200 字符） */
  summary: string
  /** 全文文件相对路径（相对于 agent journal 目录） */
  fullPath: string | null
  /** 关联的 dispatch ID（如有） */
  dispatchId?: string
  /** 产物文件列表 */
  artifacts?: string[]
}
```

**manifest.jsonl 示例**：
```jsonl
{"seq":1,"ts":"2026-05-25T10:00:00Z","type":"dispatch_received","summary":"实现用户登录 POST /login 接口","fullPath":"entries/0001-dispatch-received-a1b2c3.md","dispatchId":"d-abc123"}
{"seq":2,"ts":"2026-05-25T10:35:00Z","type":"report_sent","summary":"已完成，文件: src/auth.ts, src/auth.test.ts","fullPath":"entries/0002-report-sent-d4e5f6.md","dispatchId":"d-abc123","artifacts":["src/auth.ts","src/auth.test.ts"]}
{"seq":3,"ts":"2026-05-25T10:36:00Z","type":"session_rotated","summary":"task_complete, 已完成 1 个 dispatch","fullPath":"entries/0003-session-rotated.md"}
```

### 4.3 Entry 全文文件格式

```markdown
---
seq: 1
type: dispatch_received
ts: 2026-05-25T10:00:00Z
dispatch_id: d-abc123
from: Orchestrator
to: Alice
---

## 派单内容

实现用户登录 POST /login 接口，要求：
1. 使用 JWT token
2. 密码使用 bcrypt 哈希
3. 写单测覆盖正常/异常路径

## 注入全文

[Hive 系统消息：来自 @Orchestrator 的派单]
你的角色：Coder - 负责编码实现
...（完整注入内容）
```

### 4.4 写入时机

| 事件 | 触发点 | 写入内容 |
|------|--------|----------|
| Worker 收到 dispatch | `writeSendPrompt()` 完成后 | summary=任务摘要, fullText=注入全文 |
| Worker report | `/api/team/report` 处理成功后 | summary=报告摘要, fullText=报告全文, artifacts |
| Worker status | `/api/team/status` 处理成功后 | summary=状态文本 |
| Orch 收到 user_input | `writeUserInputPrompt()` 后 | summary=用户输入前 100 字 |
| Orch 收到 worker report | report 注入 orch 后 | summary=worker名+报告摘要 |
| Session 轮转 | 轮转执行时 | summary=原因+统计 |
| Checkpoint 保存 | `team report --checkpoint` 后 | summary=checkpoint 前 100 字, fullText=全文 |

### 4.5 摘要生成规则

摘要是确定性提取（**不用 LLM**），规则：
- `dispatch_received`：取 dispatch text 前 100 字符
- `report_sent`：取 report text 前 100 字符 + artifacts 列表
- `status_sent`：取 status text 全文（通常很短）
- `user_input_received`：取 user input 前 100 字符
- `session_rotated`：`"{reason}, 已完成 {N} 个 dispatch, 运行 {duration}"`
- `checkpoint_saved`：取 checkpoint text 前 100 字符

## 5. Session 主动轮转

### 5.1 Worker 轮转策略

#### 触发条件（满足任一即触发）

| 条件 | 阈值 | 说明 |
|------|------|------|
| 任务完成 | dispatch reported 且该 worker 无 pending dispatch | 最常见触发点 |
| 消息计数 | 累计接收 ≥ 20 条消息 | 防止单任务内部来回过多 |
| Compact 检测 | PTY 输出匹配 compact 模式 | 上下文已被压缩，意味着状态可能丢失 |
| 运行时长 | 单 session > 90 分钟 | 时间兜底 |

#### 轮转流程

```
触发条件满足
    │
    ▼
┌─────────────────────────────┐
│ 1. 写 journal entry          │
│    type: session_rotated     │
│    含统计：dispatch 数、时长   │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 2. Stop PTY (SIGTERM)        │
│    等待正常退出 (3s timeout)  │
│    超时则 SIGKILL            │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 3. 清除 session ID           │
│    （不走 resume，要干净上下文）│
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 4. Start new PTY             │
│    不带 --resume             │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 5. 注入恢复摘要              │
│    = 身份 + 航行日志最近 5 条  │
│    + pending dispatch（如有） │
│    + PROTOCOL.md 提示        │
└─────────────────────────────┘
```

#### Worker 轮转恢复注入模板

```markdown
<hive-system-message type="rotation-recovery">
你是 {workspace_name} 的 {agent_name}（{role}）。
你刚被 Hive 进行了 session 轮转（上下文刷新），这是正常操作。

## 你的航行日志（最近 5 条）
{N}. [{ts}] {type}: {summary}
   → 详见 .hive/journal/{agent_name}/entries/{filename}
...

## 当前状态
- 待处理派单：{pending_dispatch_text 或 "无，等待新派单"}
- 已完成 dispatch 数：{total_completed}

## 如需恢复完整上下文
cat .hive/journal/{agent_name}/manifest.jsonl
cat .hive/journal/{agent_name}/entries/<文件名>

## 你的规则
{worker_rules from hive-team-guidance.ts}
</hive-system-message>
```

### 5.2 Orchestrator 轮转策略

Orchestrator 轮转更审慎，需要**交接窗口**。

#### 触发条件（满足任一即触发）

| 条件 | 阈值 | 说明 |
|------|------|------|
| 消息计数 | 累计接收 ≥ 40 条消息 | Orch 消息密度高于 worker |
| Compact 检测 | PTY 输出匹配 compact 模式 | 立即触发 |
| 运行时长 | 单 session > 2 小时 | 时间兜底 |
| 空闲时段 | 所有 worker idle + 无 pending + user 静默 > 5min | 在不打扰工作的时候轮转 |

#### 轮转流程

```
触发条件满足
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. 注入 checkpoint 请求                   │
│    "请用 team checkpoint 保存当前进度"     │
│    等待 checkpoint 写入 (timeout 30s)     │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────┴──────────┐
        │ 收到 checkpoint      │ 超时 30s
        ▼                      ▼
┌───────────────┐    ┌────────────────────┐
│ 记录 checkpoint│    │ 用系统可观察数据构建 │
│ 到 journal     │    │ fallback checkpoint │
└───────┬───────┘    └────────┬───────────┘
        └──────────┬──────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 2. 写 journal entry: session_rotated     │
│    含 checkpoint + 统计                   │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 3. Stop PTY → Clear session → Start new  │
│    （同 Worker 步骤 2-4）                  │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 4. 注入恢复摘要                           │
│    = Recovery Summary (现有) +            │
│      航行日志最近 8 条 +                   │
│      checkpoint 全文                      │
└─────────────────────────────────────────┘
```

#### Orchestrator 轮转恢复注入模板

```markdown
<hive-system-message type="rotation-recovery">
你是 {workspace_name} 的 Orchestrator。
你刚被 Hive 进行了 session 轮转（上下文刷新），这是正常操作。

## 你上次的 Checkpoint
{checkpoint_text}

## 航行日志（最近 8 条）
{N}. [{ts}] {type}: {summary}
   → 详见 .hive/journal/{agent_name}/entries/{filename}
...

## 最近与 user 的对话
{recent_user_inputs from messages table, 最近 5 条}

## Active Decisions（董秘账本）
以下是用户在本 workspace 中做出的所有有效决策，你必须遵守：
{decisions_list: "[{category}] {content} — 理由：{reason}"}

## 当前活跃 worker
{worker_list with status + pending_task_count}

## 当前派单状态
{active_dispatches}

## tasks.md 当前内容
{tasks_content, 前 2000 字符}

## 如需恢复更多上下文
cat .hive/journal/{agent_name}/manifest.jsonl
cat .hive/tasks.md
team list

## 你的规则
{orchestrator_rules from hive-team-guidance.ts}
</hive-system-message>
```

### 5.3 Compact 检测

监听 PTY 输出，匹配以下模式：

```typescript
const COMPACT_PATTERNS = [
  /auto-?compacting/i,
  /conversation compacted/i,
  /context.*truncat/i,
  /summarizing conversation/i,
]
```

检测到后：
- 设置 `compactDetected = true` 标志
- **不立即轮转**——等当前操作完成（如正在执行 dispatch 中途检测到 compact，等 report 后再轮转）
- 如果 30 秒内 agent 仍在工作（PTY 有持续输出），延迟到空闲再触发

### 5.4 轮转保护

| 保护措施 | 说明 |
|----------|------|
| 最小运行时间 | 新 session 启动后 60s 内不触发轮转，防抖 |
| Dispatch 进行中 | Worker 有 active dispatch 时不轮转（等 report 后） |
| 轮转冷却 | 连续两次轮转间隔 ≥ 5 分钟 |
| 轮转失败回退 | 新 session 启动失败（3次快速退出）→ 停止自动轮转，标记为 suspended |
| 用户消息 buffer | Orch 轮转期间（~5s）user 消息入 message queue，恢复后 flush |

### 5.5 Recovery Injection Budget Control

#### 问题

Orch 轮转恢复注入的大小随 workspace 寿命单调递增：decisions 累积、tasks.md 膨胀、journal 越来越长。如果不设硬上限，会出现恶性循环：轮转越频繁 → recovery 越大 → 有效工作窗口越小 → 更快触发下一次轮转。

#### 机制

| 规则 | 阈值 | 原因 |
|------|------|------|
| Recovery 总量硬上限 | ≤ 8K tokens（~12K chars 中英混合） | 确保轮转后 agent 至少保留 80% context window 用于工作；超出此比例 recovery 本身就成了噪音 |
| 超限裁剪优先级 | tasks.md → journal 条数 → decisions → user_inputs | 越容易通过 `cat` 恢复的越先砍；decisions 和 user_inputs 是不可恢复的语义信息，最后砍 |
| User input 压缩 | 最后 1 条全文 + 前 4 条仅首行（≤80 chars） | 完整对话历史可从 journal entries 找回；recovery 只需让 Orch 知道"用户最近在说什么"，首行足以唤醒语义 |
| Decisions 注入上限 | 最多 20 条 active + 最近 7 天被引用过的 | 长寿 workspace 会积累数百条 decisions，但绝大多数在任何给定时段都不相关；`last_referenced` 时间戳标记 Orch 实际在 checkpoint/report 中提及某 decision 的时刻 |

#### Decision 引用追踪

```typescript
interface Decision {
  // ...existing fields...
  last_referenced: number | null  // epoch ms, 每次 Orch checkpoint/report 提及此 decision 时更新
}
```

更新时机：
- Orch 调 `team checkpoint` 且 checkpoint text 中包含某 decision 的 content 关键词 → 更新该 decision 的 `last_referenced`
- Hive Server 做简单字符串匹配（不用 LLM），false negative 可接受——宁可多注入几条也不丢关键约束

#### 裁剪算法（伪码）

```
budget = 8192 tokens
sections = [rules, checkpoint, decisions_filtered, journal, user_inputs, worker_list, dispatches, tasks_md]

for section in sections:
  if budget >= section.tokens:
    include(section)
    budget -= section.tokens
  else:
    include(truncate(section, budget))
    break
```

`rules` 和 `checkpoint` 永远不裁剪（它们是恢复正确性的基石）。裁剪从尾部的 `tasks_md` 开始向上逼近。

#### 与 §5.2 模板的关系

§5.2 的模板是**逻辑结构**（应该包含什么），本节是**物理约束**（实际能塞多少）。当模板内容超过 budget 时，按上述优先级裁剪，确保注入永远不超限。

---

## 6. Checkpoint 命令扩展

现有 `team report --checkpoint` 改为独立命令，支持 Orch 和 Worker：

```bash
# 保存当前进度（不关闭 dispatch）
team checkpoint "当前状态：已完成登录接口，正在写测试"

# 带文件引用
team checkpoint "进度: 80%，见 src/auth.ts" --artifacts src/auth.ts src/auth.test.ts
```

语义变化：
- 现有 `--checkpoint` 是 report 的副作用，只在 report 时顺带存
- 新增独立 `team checkpoint` 命令，可随时保存而不关闭 dispatch
- 系统主动要求 checkpoint 时（轮转前），agent 用此命令响应

## 7. 数据流全景

```
                    User Input
                        │
                        ▼
             ┌─── Orchestrator PTY ───┐
             │                         │
             │  ←── journal write ─────┼──→ .hive/journal/orch/
             │                         │
             │  ←── compact detect ────┼──→ rotation trigger
             │                         │
             └────────┬────────────────┘
                      │ team send
                      ▼
             ┌─── Worker PTY ─────────┐
             │                         │
             │  ←── journal write ─────┼──→ .hive/journal/alice/
             │                         │
             │  ←── compact detect ────┼──→ rotation trigger
             │                         │
             └────────┬────────────────┘
                      │ team report
                      ▼
              ┌─── Hive Server ───────┐
              │                        │
              │  messages table ────────┼──→ 现有 DB 记录（不变）
              │  dispatches table ──────┼──→ 现有生命周期（不变）
              │  task_events table ─────┼──→ 现有审计（不变）
              │                        │
              │  + journal writer ──────┼──→ manifest.jsonl + entries/
              │  + rotation trigger ────┼──→ kill + restart + inject
              │                        │
              └────────────────────────┘
```

## 8. 董秘机制（Secretary / Decision Ledger）

### 8.1 问题分析

Journal + Rotation 解决了"agent 自己忘了"的问题，但没解决"user-orch 沟通效率"问题：

1. **决策散落**：用户的技术决策、偏好、约束分散在几十条对话中，Orch 没有结构化索引
2. **意图漂移**：长对话中 Orch 逐渐偏离用户最初意图，用户花大量精力"拉回来"
3. **轮转断裂**：Orch 轮转后，新 session 只有 journal 的事件流，缺乏"用户到底要什么"的高层认知
4. **回来接续**：用户离开 2 小时回来，要花 5 分钟重新进入状态

### 8.2 方案：Workspace-Level Decision Ledger

引入一个 **不依赖任何 agent 上下文** 的持久化决策账本，由 Hive Server 维护，作为 user-orch 沟通的结构化外部记忆。

核心隐喻：**董秘**（Board Secretary）——不参与决策，但精确记录每一个决策及其理由，确保任何时候任何人都能回溯"我们为什么这么做"。

### 8.3 数据模型

存储路径：`<workspace_path>/.hive/decisions.jsonl`

```typescript
interface Decision {
  id: string                    // nanoid
  timestamp: number             // epoch ms
  category: 'tech' | 'scope' | 'priority' | 'constraint' | 'preference'
  content: string               // "使用 PostgreSQL，不用 MySQL"
  reason: string | null         // "团队熟悉度 + 已有基础设施"
  source: 'user' | 'orch'      // 谁提出的
  confirmed_by: 'user' | null  // 是否经用户确认
  supersedes: string | null     // 如果是修改之前的决策，指向被替代的 id
  active: boolean               // false = 已废弃/被替代
}
```

### 8.4 写入时机

| 事件 | 动作 |
|------|------|
| 用户明确表达决策/偏好 | Orch 调 `team decide "<content>" --reason "<why>"` |
| 用户否定 Orch 提议 | Orch 调 `team decide "<negation>" --reason "user rejected X"` |
| 用户修改之前的决策 | Orch 调 `team decide "<new>" --supersedes <old_id>` |
| 用户请求查看所有决策 | Orch 调 `team decisions` 输出当前 active 列表 |

### 8.5 `team` CLI 扩展

```bash
# Orchestrator 专用
team decide "<content>" [--reason "<why>"] [--category tech|scope|priority|constraint|preference] [--supersedes <id>]
team decisions [--category <cat>] [--active-only]   # 列出决策账本

# 所有 agent 可用（只读）
team decisions [--category <cat>] [--active-only]
```

### 8.6 与 Rotation 的集成

Orch 轮转恢复摘要中**自动附带** active decisions 完整列表：

```markdown
## Active Decisions（董秘账本）
以下是用户在本 workspace 中做出的所有有效决策，你必须遵守：

1. [tech] 使用 PostgreSQL 不用 MySQL — 理由：团队熟悉度
2. [scope] MVP 不含邮件通知 — 理由：时间约束
3. [constraint] API 必须向后兼容 v1 — 理由：外部客户依赖
4. [preference] commit message 用英文 — 用户偏好
```

Worker 轮转恢复摘要中附带**与当前任务相关的** decisions（由 Hive Server 按 category 过滤，worker 角色为 coder → tech + constraint；角色为 tester → tech + constraint + scope）。

### 8.7 用户可见性

UI 中 workspace 级别增加 **Decisions** 面板（sidebar tab 或 workspace detail section）：
- 展示所有 active decisions 的 timeline
- 用户可直接编辑/删除/添加（不经过 Orch，直接写 decisions.jsonl）
- 被替代的决策灰显并标注替代者
- 支持按 category 过滤

### 8.8 与 tasks.md 的区别

| 维度 | tasks.md | decisions.jsonl |
|------|----------|-----------------|
| 关注点 | **做什么**（执行层） | **为什么这么做、有什么约束**（决策层） |
| 生命周期 | 任务完成即勾掉 | 决策持续有效直到被替代 |
| 消费者 | Orch 派单决策 | 所有 agent 的行为约束 |
| 示例 | `[ ] 实现登录接口` | `必须用 JWT 不用 session，因为要支持微服务` |

### 8.9 可靠性保障

依赖 Orch 主动调 `team decide`，如果 Orch 忘了调：
- **P1**：Orch role prompt 中强调"用户做出决策时必须调用 `team decide` 记录"
- **P3（可选）**：Hive Server 端启发式检测用户消息中的决策模式（"用X不用Y"、"必须..."、"不要..."）并提示 Orch 确认记录

---

## 9. 方案关系全景

```
┌─────────────────────────────────────────────────┐
│                   用户                            │
│                    │                              │
│          ┌────────┴────────┐                     │
│          ▼                 ▼                     │
│   Orchestrator PTY    Decisions Panel (UI)       │
│          │                 │                     │
│          │  team decide    │  直接编辑           │
│          └────────┬────────┘                     │
│                   ▼                              │
│         .hive/decisions.jsonl  ← 董秘账本        │
│                   │                              │
│                   │  轮转时注入                   │
│                   ▼                              │
│         恢复摘要（rotation-recovery）             │
├─────────────────────────────────────────────────┤
│                                                  │
│   .hive/journal/<agent>/    ← 航行日志           │
│          │                                       │
│          │  轮转时注入                            │
│          ▼                                       │
│   恢复摘要（rotation-recovery）                   │
│                                                  │
└─────────────────────────────────────────────────┘
```

三层互补：
1. **Journal**：agent 活动维度的事件流（谁干了什么）
2. **Decisions**：用户决策维度的结构化约束（为什么这么干）
3. **Rotation**：利用 1+2 构建恢复摘要，实现"无损换班"

---

## 10. Schema 变更

### 10.1 新增列：agent_runs

```sql
ALTER TABLE agent_runs ADD COLUMN inject_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN rotation_reason TEXT;
```

- `inject_count`：本次 run 累计接收的消息注入数（用于阈值判断）
- `rotation_reason`：如果本次 run 是因为轮转而启动的，记录原因

### 10.2 无新表

航行日志存文件系统（.hive/journal/），不入 SQLite。理由：
- 全文可能很大（几 KB），SQLite TEXT 字段不适合频繁大文本写入
- 文件系统方便 agent 自己 `cat` 查阅
- 随 workspace 目录走，`git` 可选追踪
- 与 `.hive/tasks.md` 保持一致的存储哲学

## 11. 实现任务拆分

### Phase 1：Journal Writer（P0，~200 行）

- [ ] 新建 `src/server/agent-journal.ts`
  - `appendEntry(workspacePath, agentName, entry)`
  - `getRecentEntries(workspacePath, agentName, count)`
  - 确保目录创建 + 文件写入原子性（write to tmp + rename）
  - manifest.jsonl append-only
- [ ] `src/server/agent-stdin-dispatcher.ts` 改造
  - `writeSendPrompt` 后写 journal（dispatch_received to worker）
  - report 注入 orch 后写 journal（report_sent 给 orch）
- [ ] `src/server/routes-team.ts` 改造
  - `/api/team/report` 成功后写 journal（report_sent to worker）
  - `/api/team/status` 成功后写 journal（status_sent to worker）
  - `/api/team/checkpoint` 新端点（或复用现有 checkpoint 逻辑）

### Phase 2：Worker 轮转（P1，~300 行）

- [ ] 新建 `src/server/session-rotation.ts`
  - `createRotationPolicy(config)` → 返回判断 + 执行接口
  - Worker 轮转条件判断
  - 轮转执行（stop → clear session → start → inject）
- [ ] `src/server/recovery-summary.ts` 改造
  - 新增 `buildRotationRecovery()` 函数
  - 读取 manifest 最近 N 条构建唤醒记忆部分
- [ ] 集成：report 成功后调用 `shouldRotateWorker()`
  - 如果 true → 入队异步轮转（避免阻塞 HTTP 响应）

### Phase 3：Compact 检测 + Orch 轮转（P2，~250 行）

- [ ] 新建 `src/server/compact-detector.ts`
  - 接入 `PtyOutputBus` 监听
  - 正则匹配 compact 模式
  - 发射 `compactDetected` 事件
- [ ] `src/server/session-rotation.ts` 扩展
  - Orch 轮转条件判断
  - Checkpoint 请求 + 等待逻辑
  - Fallback checkpoint 构建
- [ ] Orch 轮转恢复注入（扩展 recovery-summary）

### Phase 4：董秘机制（P2，~200 行）

- [ ] 新建 `src/server/decision-ledger.ts`
  - `appendDecision(workspacePath, decision)`
  - `getActiveDecisions(workspacePath, category?)`
  - `supersede(workspacePath, oldId, newDecision)`
  - decisions.jsonl append-only + active 标记
- [ ] `src/cli/team-decide.ts` — `team decide` 命令实现
- [ ] `src/cli/team-decisions.ts` — `team decisions` 只读查询
- [ ] `src/server/routes-team.ts` 扩展
  - `/api/team/decide` POST 端点
  - `/api/team/decisions` GET 端点
- [ ] `src/server/recovery-summary.ts` 改造
  - Orch 恢复注入中追加 active decisions 列表
  - Worker 恢复注入中按角色过滤相关 decisions

### Phase 5：CLI 扩展 + 前端（P3，可选）

- [ ] `team checkpoint` 独立命令
- [ ] UI 展示 journal（workspace detail 新 tab/section）
- [ ] UI Decisions Panel（用户直接编辑/删除/添加决策）
- [ ] 轮转通知 UI toast

## 12. 验证标准

| 场景 | 预期行为 |
|------|----------|
| Worker 完成 1 个 dispatch，无 pending | 自动轮转，新 session 注入含刚完成的 report 摘要 |
| Worker 连续执行 3 个 dispatch | 每次 report 后轮转，第 3 次恢复注入含前 2 次的摘要 |
| Orch 运行 2h 后 | 触发轮转，checkpoint 注入 + manifest 摘要 |
| Orch 被 auto-compact | compact 检测触发，等空闲后轮转 |
| Worker 轮转时有新 dispatch pending | 新 session 恢复注入包含 pending dispatch 全文 |
| Hive runtime 重启 | 走已有 auto-resume 逻辑（不受本方案影响） |
| Worker 被删除 | 走已有 handoff 逻辑（不受本方案影响） |
| 轮转失败（CLI 启动崩溃） | 3 次快速退出后停止自动轮转 |
| cat .hive/journal/Alice/manifest.jsonl | 可看到完整的活动时间线 |
| Orch 调 `team decide` 记录用户决策 | decisions.jsonl 新增一条 active 记录 |
| 用户修改决策 `--supersedes` | 旧决策 active=false，新决策指向 supersedes |
| Orch 轮转后恢复注入 | 包含所有 active decisions 列表 |
| Worker 轮转后恢复注入 | 包含按角色过滤的相关 decisions |
| 用户 UI 直接编辑 decisions | 下次轮转恢复注入反映最新状态 |
| `team decisions --active-only` | 只输出 active=true 的条目 |

## 13. 开放问题

1. **Journal 文件清理策略**：entries 目录会累积，需要 rotation 还是按 workspace 生命周期？
   - 建议：保留最近 100 条，超出后 archive 到 `.hive/journal/<name>/archive/`
2. **Git 追踪**：`.hive/journal/` 是否加入 `.gitignore`？
   - 建议：默认 ignore（运行时产物），用户可选 opt-in
3. **多实例冲突**：同名 agent 删了又建，journal 目录冲突？
   - 建议：目录名用 `<agent-name>-<agent-id-prefix>` 确保唯一
4. **摘要质量**：确定性截断可能切断关键信息
   - 建议：P1 阶段足够，P3 考虑可选 LLM 摘要模式
5. **Orch 轮转期间 worker report 到达**：
   - 由 `OrchMessageQueue` 自然 buffer（已有 5s batch window），轮转完成后 flush
6. **决策提取可靠性**：依赖 Orch 主动调 `team decide`，如果 Orch 忘了调？
   - P1：Orch role prompt 强调必须记录决策
   - P3：Hive Server 端启发式检测用户消息中的决策模式（"用X不用Y"、"必须..."、"不要..."）并提示 Orch 确认
7. **decisions.jsonl 膨胀**：长期运行会否产生太多条目？
   - Active decisions 通常不超过 50 条（被替代的自动 inactive）
   - 恢复注入只读 active=true 的条目
8. **多 workspace 决策继承**：新建 workspace 是否能从已有 workspace 复制决策？
   - 建议 MVP 不做，workspace 完全隔离
