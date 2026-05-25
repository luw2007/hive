# Hive HR 角色设计

> 状态：Draft  
> 日期：2026-05-25  
> 规划：颜真卿

## 1. 动机

当前 Hive 缺乏对团队效能的观察和反馈机制。Orchestrator 专注任务分发，无人关注 worker 是否高效、编制是否合理。HR 角色填补这个空白——作为一个观察型 agent，它分析团队运行数据并向用户提出人员调整建议。

## 2. 职责边界

| 能力 | 描述 | 约束 |
|------|------|------|
| 评估员工状态 | 分析各 worker 的派单完成率、响应时间、失败率 | 只读观察，不干预执行 |
| 建议创建员工 | 识别瓶颈后建议新增特定角色的 worker | 仅建议，需人工确认 |
| 建议删除员工 | 识别长期 idle/低效 worker 建议裁减 | 仅建议，需人工确认 |
| 建议角色调整 | 建议修改 worker 的角色描述 | 仅建议，需人工确认 |

**不做的事**：
- 不派单（Orchestrator 职责）
- 不评审代码（Reviewer 职责）
- 不直接执行 worker 增删（只建议）

## 3. 交互流程

```
HR Agent 观察 dispatch history + team list
       │
       ▼
┌─────────────────────────┐
│ 生成建议 (team report)   │
│ • action: create/delete │
│ • reason: 分析依据       │
│ • params: 角色/名称等    │
└─────────┬───────────────┘
          │
          ▼
┌─────────────────────────┐
│ UI 确认弹窗 (v2)         │
│ [建议摘要]               │
│ [✓ 批准]  [✗ 拒绝]      │
└─────────┬───────────────┘
          │
     ┌────┴────┐
     ▼         ▼
  批准        拒绝
  执行API     记录日志
  通知HR      通知HR
```

MVP 阶段不实现确认弹窗，HR 建议以文本报告形式呈现，用户手动执行。

## 4. 技术路线

### 4.1 Role Template

HR 作为内置 role template（`is_builtin: true`），类型 `custom`：

```typescript
export const HR_ROLE_DESCRIPTION = [
  '你是 Hive 的 HR 角色，负责观察团队效能并提出人员调整建议。',
  '工作方式：',
  '- 定期分析各 worker 的派单完成率、响应时长和失败模式。',
  '- 识别瓶颈后生成结构化建议。',
  '- 建议需通过 team report 提交，等待用户审批。',
  '- 不主动执行任何变更，不干预其他 worker 的执行过程。',
].join('\n')
```

### 4.2 评估数据源（全部复用现有 API）

| 数据 | 来源 | 现有支持 |
|------|------|----------|
| 派单完成率 | `dispatch-ledger-store.listDispatches()` 按 agent 分组 | ✅ |
| Worker 状态 | `team list` 返回的 status 字段 | ✅ |
| 响应时间 | `created_at` → `reported_at` 时间差 | ✅ |
| 失败率 | cancelled dispatches 比例 | ✅ |

### 4.3 建议处理机制（v2 新增）

| 模块 | 用途 |
|------|------|
| `src/server/hr-suggestion-handler.ts` | 解析 HR report 中的结构化建议，存入 pending queue |
| `web/src/hr/HrSuggestionDialog.tsx` | 确认弹窗组件 |
| `src/server/routes-hr.ts` | `GET /api/ui/.../hr-suggestions` + `POST .../approve\|reject` |

## 5. MVP 范围

### v1（2-3 天）
- HR 内置 role template
- HR 通过观察 dispatch history 生成文本评估报告
- 报告通过 `team report` 提交，在 dispatch history 中可见
- **不做**结构化解析和确认流程

### v2（+2-3 天）
- 结构化建议解析 + 确认弹窗
- 一键执行（批准后自动 create/delete worker）
- HR 评估触发方式可配置

### v3（远期）
- Worker 效能对比仪表盘
- 自动触发规则（idle > 30min 建议裁减）
- 评估历史趋势分析

## 6. 任务拆分

- [ ] #8 HR 角色模板
  > 新增 HR 内置 role template，角色描述引导 agent 做团队效能观察
  > 验收：Add Worker 列表出现 HR 角色；HR worker 启动后能观察 team list

- [ ] #8.1 HR 评估报告
  > HR worker 能分析 dispatch history 并生成效能评估文本报告
  > 验收：报告包含各 worker 完成率/时长分析；在 dispatch history 可查看

- [ ] #8.2 HR 建议确认（v2）
  > HR 结构化建议触发 UI 确认弹窗，用户批准后自动执行
  > 验收：建议弹出确认框；批准执行对应 API；拒绝记录日志

## 7. 风险与开放问题

1. **HR 无需专属 CLI agent**——复用通用 Claude Code + HR 提示词即可
2. **评估数据范围**：只用 dispatch 数据，不解析终端输出（避免隐私争议）
3. **与 Orchestrator 边界**：HR 不参与任务分配，只在团队编制维度给建议
