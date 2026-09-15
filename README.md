# 当前正式服务

正式员工与负责人页面使用 `server/app.py`（Python/SQLite）。本轮插单、并行、审核计分规则见 [PRIORITY-REVIEW-POINTS](docs/PRIORITY-REVIEW-POINTS.md)。启动：`python3 server/app.py --port 4312 --database /path/to/tasks.db`。

下方保留旧 Vinext/D1 原型说明，其每小时换算点数规则不适用于正式审核得分。

# 两人游戏团队每日任务系统

这是一个使用 Vinext、Cloudflare D1（SQLite）和 Drizzle 的本地任务看板，固定服务于 ZHC 与 YWT 两名成员。

## 本地启动

环境要求：Node.js 22.13 或更高版本。

```bash
npm install
npm run dev:ready
```

`dev:ready` 会先把 `drizzle/` 中尚未执行的迁移应用到项目本地的 SQLite 数据库，再启动开发服务器。打开终端打印的 Local URL 即可使用。数据保存在被 Git 忽略的 `.wrangler/state/` 中，重新启动后仍会保留。

后续数据库模型变更时先运行 `npm run db:generate`，检查生成的 SQL，再执行 `npm run db:migrate:local`。

## 工作流

- 创建任务时可以直接指派给 ZHC/YWT，也可以暂不指派进入任务池。
- 未指派任务由当前操作者领取；负责人可以开始、暂停、继续、提交待验收、标记阻塞和解除阻塞。
- 待验收任务可以验收通过或退回修改；只有验收通过才计入今日完成点数。
- 预计工时按每小时 1 点、半点取整换算。今日计划、完成和剩余点数分别按负责人计算。
- 美术任务保存过程图、最终稿和源文件链接；测试任务保存计划/实际 Case 数，以及新增、有效、回归和严重 BUG 数。
