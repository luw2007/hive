# Worker 删除交接设计

> 状态：Draft  
> 日期：2026-05-25  
> 规划：颜真卿（产品方案）+ 汪大渊（技术补充）

## 1. 目标

Worker 被删除时，其工作上下文不应丢失。通过交接机制回收关键信息（未完成事项、工作摘要、session ID），确保后续 worker 或 Orchestrator 能接续工作。

## 2. 交互流程

```
用户点击删除 Worker
       │
       ▼
┌────────────────────────────────────────┐
│ 确认弹窗                                │
│ "即将删除 @米芾，是否先执行工作交接？"    │
│                                         │
│ [交接后删除]  [直接删除]  [取消]         │
└────┬──────────────┬──────────────┬─────┘
     │              │              │
     ▼              ▼              ▼
  交接流程       强制删除         取消
     │         (跳过交接，        (不操作)
     │          仍存最小记录)
     ▼
┌─────────────────────────────┐
│ 判断 Agent 状态              │
│ running/idle → 主动上报模式  │
│ stopped     → 被动回收模式  │
└──────┬──────────────┬───────┘
       │              │
       ▼              ▼
  主动上报          被动回收
  (注入stdin,       (系统提取
   等report)        recovery数据)
       │              │
       └──────┬───────┘
              ▼
  保存交接报告 → 停止 PTY → 删除 Worker
              │
              ▼
  通知 Orchestrator（系统消息注入 stdin）
```

## 3. 两种模式

### 3.1 主动上报模式

**触发条件**：Agent 状态 = running 或 idle

**流程**：
1. 系统向 Agent PTY stdin 注入交接指令
2. 指令模板：`"你即将被删除，请执行 team report 提交工作交接摘要，包含：已完成工作、未完成事项、关键上下文和建议。"`
3. 等待 `team report`（超时 30s）
4. 收到 report → 保存为交接报告
5. 超时 → 自动转入被动回收模式

**优势**：Agent 有完整上下文理解，摘要质量高

### 3.2 被动回收模式

**触发条件**：Agent 状态 = stopped，或主动模式超时

**流程**：
1. 从 `recovery-summary` 逻辑提取最近任务事件
2. 从 `dispatch-ledger-store` 查询该 agent 的未完成派单
3. 从 `session-capture` 获取 session ID
4. 从 `agent_runs.checkpoint_json` 提取最近 checkpoint 数据
5. 组装为结构化交接报告

**优势**：100% 可用（不依赖 Agent 配合），即时完成

### 3.3 对比

| 维度 | 主动上报 | 被动回收 |
|------|----------|----------|
| 数据来源 | Agent 自述 | 系统拼接 |
| 数据质量 | 高 | 中 |
| 延迟 | ≤30s | 即时 |
| 覆盖率 | 依赖 Agent 配合 | 100% |
| 适用场景 | Agent 存活中 | Agent 已停止/无响应 |

## 4. 数据存储

### 4.1 分歧点：独立表 vs 复用 checkpoint_json

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A. 新建 `handoff_reports` 表** | 语义清晰；独立生命周期；可按 workspace 级联删除；支持独立 UI 查询 | 新增 schema migration；多一张表维护 |
| **B. 复用 `agent_runs.checkpoint_json`** | 零新增表；与现有 run 记录天然关联 | 语义混淆（checkpoint 是"恢复点"，handoff 是"终结摘要"）；agent_runs 行可能被清理；不便独立列表查询 |

### 4.2 推荐：方案 A（独立表）

理由：
1. **语义分离**：checkpoint 是给 agent 自己恢复用的，handoff 是给其他 agent/用户看的——读者不同、格式不同
2. **生命周期不同**：checkpoint 随 run 结束可清理，handoff 需长期保留
3. **查询模式不同**：UI 需要"列出该 workspace 所有交接历史"——独立表一行 SQL，复用 checkpoint 需 JOIN + 过滤
4. **向前兼容**：v2 增加"继承给其他 worker"功能时，独立表容易扩展（加 `inherited_by_agent_id` 字段）

### 4.3 Schema

```sql
CREATE TABLE handoff_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('active', 'passive')),
  report_text TEXT NOT NULL,
  pending_dispatches_json TEXT,  -- JSON: [{dispatchId, text, state}]
  session_id TEXT,               -- 用于可能的 resume
  checkpoint_snapshot TEXT,      -- 从 agent_runs.checkpoint_json 快照
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_handoff_workspace ON handoff_reports(workspace_id, created_at DESC);
```

### 4.4 TypeScript 接口

```typescript
interface HandoffReport {
  id: string
  workspaceId: string
  agentId: string
  agentName: string
  mode: 'active' | 'passive'
  reportText: string
  pendingDispatches: Array<{
    dispatchId: string
    text: string
    state: DispatchStatus
  }>
  sessionId: string | null
  checkpointSnapshot: string | null
  createdAt: number
}
```

## 5. 与现有机制关系

| 现有模块 | 复用方式 |
|----------|----------|
| `recovery-summary.ts` | 复用 `formatTaskEvents` + `formatOpenTasks` 生成被动摘要 |
| `session-capture.ts` | 获取 session ID 存入报告 |
| `dispatch-ledger-store` | 查询该 agent 的 pending/submitted dispatches |
| `message-log-store` | 获取最近对话记录作为上下文来源 |
| `agent-run-store` | 获取 run 状态 + checkpoint_json 快照 |
| `system-message.ts` | 复用 `wrapSystemMessage` 格式通知 Orch |

**核心洞察**：被动回收模式 ≈ recovery-summary 的变体。区别仅在输出对象（recovery 给重启的 agent，handoff 给 Orch/用户）和输出格式。建议从 `recovery-summary.ts` 导出通用函数 `buildHandoffSummary()`。

## 6. MVP 范围

### v1（2-3 天）
- 三按钮确认弹窗
- 主动上报：注入 stdin + 等待 report（30s 超时）
- 被动回收：复用 recovery-summary 生成摘要
- 交接报告存 `handoff_reports` 表
- 删除后通知 Orchestrator（系统消息）

### v2（+1-2 天）
- UI 查看交接历史（workspace drawer 新 tab 或 section）
- "继承给"选项：选择另一个 worker 接收未完成派单
- session ID 自动注入新 worker 的 resume 参数

### v3（远期）
- 交接质量评分（主动 vs 被动对比）
- 自动触发：worker idle 过长系统建议删除+交接
- 与 HR 角色联动：HR 建议删除时自动走交接流程

## 7. 任务拆分

- [ ] #12 删除交接弹窗
  > 描述：删除 worker 时弹出三选一确认（交接后删除/直接删除/取消）
  > 验收：三个按钮各走不同流程；直接删除仍存最小 passive 记录

- [ ] #13 主动交接上报
  > 描述：running/idle agent 删除前注入交接指令，等待 report
  > 验收：agent 收到交接提示后 report 摘要；超时 30s 自动转被动模式

- [ ] #14 被动交接回收
  > 描述：stopped 或超时的 agent，从 recovery-summary + checkpoint + dispatches 组装报告
  > 验收：报告含任务事件 + 未完成派单 + session ID + checkpoint 快照；存入 DB

- [ ] #15 交接通知 Orch
  > 描述：交接完成后以系统消息通知 Orchestrator
  > 验收：Orch 收到通知含 worker 名 + 交接摘要 + 未完成事项清单

## 8. 开放问题

1. **"直接删除"是否也存记录？** 推荐：是。仍走被动回收存一份最小报告，只是不等主动上报
2. **交接报告保留时长？** 建议与 workspace 同生命周期，workspace 删除时级联清理
3. **多 session ID 情况？** 取最近一次 run 的 session ID 即可
