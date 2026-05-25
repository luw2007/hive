# Task/派单融合架构提案

**日期**：2026-05-25
**状态**：Draft / Pending review
**作者**：汪大渊 (Architect)

---

## 问题陈述

当前 Hive 的任务系统和派单系统已有 `dispatches.task_id` 外键关联，但用户侧体验仍然割裂：
1. 创建任务的入口深藏在 TaskGraphDrawer 中
2. Orch 必须手动维护 tasks.md 一致性
3. 缺乏独立 agent 辅助任务规划
4. `.hive/tasks.md` 双写机制维护成本高

本文给出四个维度的方案对比，供决策。

---

## 1. Task 与 Dispatch 关系：融合 vs 分离

### 现状

- **Task**：`tasks` 表（id, workspace_id, title, status, source, seq）+ `.hive/tasks.md` 双写
- **Dispatch**：`dispatches` 表（id, workspace_id, to_agent_id, text, status, task_id）
- 关系：`dispatches.task_id` → 1 Task : N Dispatches

### 方案 A：保持分离（推荐 ✓）

| 维度 | Task（需求层） | Dispatch（执行层） |
|---|---|---|
| 语义 | "要做什么" | "谁在做 + 执行状态" |
| 创建者 | 用户 / Orch / 讨论 | 系统（`team send` 触发） |
| 生命周期 | proposed → open → done | pending → delivered → reported |
| 重试 | 同一 task 可 N 次 dispatch | 单次不可变 |

**优势**：概念清晰；一个任务可失败重试/拆分多次派；已有架构自然延续。
**劣势**：两表状态需同步。

### 方案 B：合并为单一 work_items 表

**优势**：少一层抽象。
**劣势**：丢失重试语义；用户手动创建的 task（无 worker）无法表达；与 markdown 格式冲突。

### 结论

保持分离。强化关联：dispatch 创建时自动 link task_id；dispatch reported 时产生 suggestion 事件（已在 unified-task-model.md 中定义）。

---

## 2. 右下角 FAB 交互方案

### 现状

TaskGraphDrawer 右上角工具栏 "+" 按钮，或直接在 markdown 中输入。入口深、步骤多。

### 方案：Floating Action Button + Mini 表单

```
┌──────────────────────────────────┐
│  WorkspaceDetail (三面板)         │
│                                  │
│                                  │
│                                  │
│                         ┌──────┐ │
│                         │  ＋  │ │  ← FAB (56×56px)
│                         └──────┘ │
└──────────────────────────────────┘
```

**点击后**：弹出 inline popover（不遮挡主视图）

```
┌─────────────────────────┐
│ 新建任务                 │
├─────────────────────────┤
│ 标题: [________________] │
│ 指派: [▾ 选择 worker   ] │  ← 可选
│ 标签: [▾ 优先级        ] │  ← 可选
│         [创建] [取消]    │
└─────────────────────────┘
```

**行为**：
- 提交 → `POST /api/team/tasks`（已有）
- 若选了 worker → 自动触发 dispatch（一步完成 task + 派单）
- 快捷键：`Ctrl+Shift+T` 全局唤起

**技术实现**：
- 新增 `web/src/tasks/QuickTaskFab.tsx`
- 位置：`position: fixed; right: 24px; bottom: 24px; z-index: 50`
- 与三面板布局兼容：浮在所有面板之上

---

## 3. 独立 Agent 驱动：董秘

### 概念

| 角色 | 视角 | 职责 |
|---|---|---|
| **董秘 Agent** | workspace 内 | 任务分解、worker 协调建议、状态汇总 |

### 技术规格

| 维度 | 说明 |
|---|---|
| 生命周期 | 每 workspace 一个（类 Orch 的辅助 agent） |
| 数据访问 | 当前 workspace 的 tasks + dispatches + worker 状态 |
| UI 入口 | 右下角 chat bubble（类 intercom widget） |
| 与 Orch 关系 | 辅助 Orch（只建议，不替代） |
| 实现复杂度 | 中（特殊角色 PTY + 独立 UI 面板） |

### 实现方案

1. **角色模板**：内置 `secretary` 角色，不出现在 worker 列表
2. **PTY**：与其他 agent 相同的 PTY 进程，共享 `team` CLI 能力
3. **UI**：右下角 chat bubble → 展开为独立小面板（300×400px）
4. **能力**：
   - 读 tasks 表 + dispatch 状态 + worker 状态
   - 输出建议文本（创建任务 / 发起讨论 / 调整 worker 分配）
   - **不直接执行**——用户确认后系统执行
5. **触发**：用户主动唤起 / task 积压超阈值时提示

---

## 4. .hive/tasks.md 替代方案

### 三种路线

| 方案 | Source of Truth | .hive/tasks.md 角色 | Agent 操作方式 |
|---|---|---|---|
| **A. 双写**（现状） | 模糊（md ↔ DB 双向 watch） | 可读写主源 | 直接编辑文件 |
| **B. SQLite 唯一** | SQLite `tasks` 表 | 删除 | `team task create/done` CLI |
| **C. SQLite 主 + md 只读投影**（推荐 ✓） | SQLite `tasks` 表 | 只读投影（自动生成） | `team task create/done` CLI |

### 推荐方案 C 详细设计

**数据流**：
```
用户/Orch/讨论 → team task create → SQLite tasks 表
                                         ↓ (onChange)
                                   regenerate .hive/tasks.md
                                         ↓
                                   git diff 可追踪
```

**变更**：
- 去掉 chokidar 双向 file watch → 改为单向 DB→md 生成
- `team` CLI 新增子命令：`team task create "<title>"` / `team task done <seq>` / `team task list`
- `.hive/tasks.md` 仍可 git commit（人类可读历史）
- Agent 不再直接编辑 markdown（避免格式损坏）

**兼容性**：
- Layer B 恢复仍读 `.hive/tasks.md`（文件始终存在，只是系统生成）
- 旧版 tasks.md 迁移：首次启动时解析 markdown → 导入 DB

---

## 决策矩阵

| 决策点 | 推荐方案 | 次选 | 否决 |
|---|---|---|---|
| Task/Dispatch 关系 | 保持分离，强化关联 | — | 合并为单表 |
| 新建任务入口 | 右下角 FAB + mini 表单 | 保留 TaskDrawer 内按钮 | — |
| 独立 Agent | 董秘（workspace 内） | 跳过，仅增强 Orch prompt | — |
| 数据源 | SQLite 主 + md 只读投影 | 保持双写 | 删除 md |

---

## 实施顺序建议

1. **P0**：`team task` CLI 子命令 + SQLite 单向生成 md（基础设施）
2. **P1**：右下角 QuickTaskFab 组件
3. **P2**：董秘 agent 角色模板 + chat bubble UI

---

## 影响范围

| 模块 | 改动 |
|---|---|
| `bin/team` CLI | 新增 `task` 子命令 |
| `src/server/task-service.ts` | 新增 regenerateMarkdown() |
| `src/server/tasks-file-watcher.ts` | 改为单向（去掉 md→DB sync） |
| `web/src/tasks/QuickTaskFab.tsx` | 新增 FAB 组件 |
| `web/src/secretary/` | 新增董秘 UI 面板 |
| `src/server/agent-startup-instructions.ts` | 董秘角色模板 |
| DB migration | 无新表（tasks 表已满足） |
