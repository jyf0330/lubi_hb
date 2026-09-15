# 自然语言任务登记与 DeepSeek

本功能接入当前 `server/app.py` 员工工作台（`employee.html`），沿用 Python/SQLite 服务及现有反向代理，不迁移至仓库中另一套 Vinext/D1 页面。

## 员工流程

粘贴自然语言 → AI 整理 → 编辑大任务及 1–8 个小任务 → 确认登记整组任务。若登记后才发现漏拆，可在原大任务卡片点击“补充小任务”。
支持添加、删除、上移、合并小任务，也支持手动整理及原有五字段文本。AI 失败保留原文；原文草稿仅在当前设备按员工保存。切换员工不沿用上一个人的预览。

大任务仅作粗略参考和状态汇总，不独立计时或计点。大任务预计时间允许为空，填写后也不要求等于小任务合计；小任务可以按实际执行粒度独立估时。小任务继续使用既有开始、暂停、继续、提交待验收流程。大任务只有所有子任务验收通过才显示已完成。混合已完成/待验收显示待验收，返工和阻塞优先反映。负责人看板增加汇总和所属大任务名称，原有每日统计只统计子任务，不重复计数。

补充小任务会保留已有子任务的状态、计时、进展、交付物和验收记录，新项以“今日待办”加入同一大任务。提交时必须填写补充原因；原因会写入新任务备注和任务事件，并记录补充前后的子任务预计合计。窗口也可一并调整尚未提交或验收的小任务预计分钟；已提交/验收的历史项锁定，实际计时不改。每个大任务最多 8 个小任务，补充后的子任务预计合计滚动更新，但不改写大任务最初填写的参考时间，不重复计算历史实际工时或得分。已完成的大任务也可补充，新增项完成后才会重新汇总为已完成。

AI 无法获知的数量、尺寸、验收细节显示待补充。预览里的待核对提示保留为生成记录，员工在任务字段中补充最终约定。未提供工时允许在草稿中为空，但确认时须填写。预计总时间可以为空，若填写仅作大任务粗略参考，不必等于子任务合计。模型不获得任何登记、计时或验收工具权限。

## 服务端配置

- `DEEPSEEK_API_KEY`：服务进程环境变量，必需。不要写入前端、仓库、日志或聊天。
- `DEEPSEEK_MODEL`：可选，默认 `deepseek-flash`，可设为账户可用的模型名。
- 官方固定端点 `https://api.deepseek.com/chat/completions`，JSON Output，非流式，关闭思考，45 秒网络超时；不自动重试付费请求。
- 每员工同一时间只允许一次整理，两次请求至少间隔10秒；该限制随进程重启重置。沿用现有姓名登录，并未增加强身份认证。
- 未配置时，页面明确提示 DeepSeek AI 尚未配置，手动登记仍可用。浏览器不接收密钥或上游错误正文。

已有 systemd 服务应通过其受限 EnvironmentFile 注入配置，保持文件仅服务管理员可读；然后仅重启本项目服务。密钥的实际位置与重启操作需按本次授权核对，本文不假设生产已有配置。

API 依据：[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 与 [首次调用](https://api-docs.deepseek.com/)，核对日期 2026-09-09。

## 接口与数据

- `POST /api/employee/plan`：已登录员工提交 `source_text`，返回 `plan`，不写任务数据库。
- `POST /api/employee/create-plan`：提交 `plan`、`source_text`、`request_id`。后端重新验证、在同一事务中创建大任务和全部小任务。
- `POST /api/employee/append-plan`：已登录员工提交 `group_id`、`reason`、1–8 个 `tasks`，以及可选的 `estimate_updates`（小任务编号和新预计分钟）；后端校验归属、历史状态、字段、工时及 8 项上限后，在同一事务中按各小任务独立时间追加到原大任务。`request_id` 可用于安全重试，同一编号和内容不会重复创建。
- 幂等键按员工隔离。相同键和内容重试返回已有结果；相同键不同内容拒绝。失败不会残留部分任务。
- `task_groups` 保存父任务、原文、待核对提示及幂等信息；`tasks.group_id/group_order` 保存正式归属与顺序，旧任务保持无归属。
- 启动时只执行增量建表/加列，重复启动不会丢数据。现有旧成员迁移仍沿用原逻辑。
- 发布前以 SQLite backup 方式备份现有库；回退旧代码无需删除新增表或列，勿用旧数据库覆盖发布后的新增任务。

## 验证与运行

`python3 -m unittest discover -s tests -v` 验证隔离 SQLite/HTTP 流程，包括模型模拟、工时校验、身份隔离、事务回滚、重试去重、子任务状态汇总及登记后补充小任务；模拟模型不等于真实 DeepSeek 验证。

`node tests/work-paste.cjs` 验证旧文本兼容。

本地预览使用临时数据库启动 `python3 server/app.py --port 4313 --database /tmp/board-preview/tasks.db`；不要用测试账户或测试任务写生产库。

## 本次验证与发布（2026-09-15）

- 原有任务计划测试覆盖父任务时间与子任务时间不一致仍可登记，以及登记后补充小任务；旧文本解析与任务编辑器交互脚本通过；Python/JavaScript 语法检查通过。
- 使用当前进程已有的 DeepSeek 环境配置真实调用成功：原文整理成 1 个大任务、5 个小任务，60/180/120/60/60 分钟，合计 480 分钟；包含缺失数量、尺寸等提示。未向正式任务库登记此测试。
- 本地 29 项 Python 测试、旧文本兼容测试、Python/JavaScript 语法检查及 diff 检查通过；当前环境的 DeepSeek 最小化草稿调用成功。
- 已发布 `task_planner.py` 与 `static/employee.js` 到 `/opt/game-team-board`；线上 `game-team-board.service` 重启后保持 active，健康接口返回 200。
- 与线上现有文件比较，本次发布范围为 `task_planner.py` 与 `static/employee.js`；不发布仓库中的其他未提交改动。
- 已将当前 DeepSeek 配置安全写入 `/etc/game-team-board.env`，仅保留 `DEEPSEEK_API_KEY` 已配置状态和 `DEEPSEEK_MODEL=deepseek-flash`；文件权限为 `600 root:root`，密钥未进入仓库、前端、日志或聊天。
- 通过线上服务本机 API 与正式员工页面验证：登录、DeepSeek 草稿生成、页面“AI 整理（DeepSeek）”文案均成功；测试草稿未确认登记。
- 发布前备份位于 `/opt/game-team-board/backups/`，本次备份标记为 `20260915-180722`；未发布仓库中无关的 `lib/task-attachments.ts` 与 `components/file-attachment-field.tsx`。
