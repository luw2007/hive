# New Features Test Plan

## 一、右下角 FAB 快速创建任务

### 正常路径
- [ ] TC-FAB-01: 点击 FAB 按钮弹出任务创建面板
- [ ] TC-FAB-02: 输入标题 + 描述，点提交，任务出现在 .hive/tasks.md 且 UI 实时更新
- [ ] TC-FAB-03: 指派给已存在的 idle worker，worker 收到派单
- [ ] TC-FAB-04: 指派给已存在的 working worker，任务进入该 worker 队列
- [ ] TC-FAB-05: 不指派（留空），任务创建为 unassigned 状态
- [ ] TC-FAB-06: 快捷键触发 FAB（如 Cmd+K 或指定热键）

### 异常路径
- [ ] TC-FAB-07: 空标题提交 → 阻止提交 + 显示校验提示
- [ ] TC-FAB-08: 标题超长（>500 字符）→ 截断或拒绝
- [ ] TC-FAB-09: 指派给不存在的 worker name → 错误提示 / 回退为 unassigned
- [ ] TC-FAB-10: 指派给 stopped worker → 提示 worker 已停止，确认是否排队
- [ ] TC-FAB-11: 网络断开时提交 → 显示 toast 错误，不丢失输入内容
- [ ] TC-FAB-12: 连续快速点击提交 → 防重复提交（debounce/disable）

### 边界
- [ ] TC-FAB-13: workspace 无 worker 时，指派下拉为空或隐藏
- [ ] TC-FAB-14: 面板打开时切换 workspace → 面板关闭或切换到新 workspace 上下文

---

## 二、HR 角色

### Role Template 创建
- [ ] TC-HR-01: 添加 Worker 时选择 HR 角色模板 → worker 成功创建且 role=custom, roleTemplateName='HR'
- [ ] TC-HR-02: HR 角色模板包含正确的 system prompt（评估/汇报/建议方向）
- [ ] TC-HR-03: HR 模板出现在 Add Worker 对话框的角色选择列表中
- [ ] TC-HR-04: 删除 HR 模板 → 确认弹窗 → 模板移除，不影响已创建的 HR worker

### 评估报告格式
- [ ] TC-HR-05: HR worker 产出的评估报告包含结构化字段（worker name / 评估项 / 分数 / 建议）
- [ ] TC-HR-06: 评估报告通过 team report 汇报给 Orchestrator，格式可解析
- [ ] TC-HR-07: 评估报告中引用了被评估 worker 的实际产出（非空泛评价）

### 建议触发条件
- [ ] TC-HR-08: worker 连续 N 次任务失败 → HR 自动发起评估（如由 Orch 派单）
- [ ] TC-HR-09: worker idle 超过阈值 → HR 建议回收或重新分配
- [ ] TC-HR-10: 手动触发：Orch 主动派单让 HR 评估指定 worker
- [ ] TC-HR-11: HR 建议"替换 worker" → Orch 收到建议后可执行 stop + 新建

---

## 三、员工交接

### 主动上报路径（worker 自己发起）
- [ ] TC-HO-01: worker 调用 team report "交接：<内容>" → Orch 收到交接消息
- [ ] TC-HO-02: 交接内容包含：当前进度、未完成项、阻塞原因、建议接替方案
- [ ] TC-HO-03: worker report 后状态变为 idle/stopped（视实现）
- [ ] TC-HO-04: Orch 收到交接后自动创建后续任务（含交接上下文）派给新 worker
- [ ] TC-HO-05: 新 worker 的 stdin 中能看到前任的交接内容

### 被动回收路径（Orch/系统发起）
- [ ] TC-HO-06: Orch 发送 team send <worker> "停止并交接当前工作" → worker 执行交接流程
- [ ] TC-HO-07: worker 超时未响应 → 系统标记为 stopped，生成摘要交接（从最后 N 条 output 提取）
- [ ] TC-HO-08: worker PTY crash → 系统生成 fallback 交接摘要（含 crash 原因 + 最后状态）
- [ ] TC-HO-09: 回收后 worker 的排队任务自动转移给 Orch（或新 worker）
- [ ] TC-HO-10: 交接前后 .hive/tasks.md 状态一致（未完成任务不会丢失标记）

### 边界
- [ ] TC-HO-11: 同时回收多个 worker → 交接消息不交错，Orch 逐条处理
- [ ] TC-HO-12: 交接内容超长（>10KB）→ 走 --stdin 模式，不截断
- [ ] TC-HO-13: worker 正在执行 team report 时被 kill → 交接消息是否部分丢失
