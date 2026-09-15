> 2026-09-09 后续规则变更：正式服务现允许并行计时，原文“单员工单项计时”已被替换。多任务时暂停及 hb 必须传 task_id；新工具和计分规则见 [PRIORITY-REVIEW-POINTS](PRIORITY-REVIEW-POINTS.md)。

# 腾讯云 Python 服务 MCP 接入

2026-09-09 核实主 checkout `server/app.py`：正式业务为 Python/SQLite，已有 12 个 MCP 工具（含登记后补拆）；旧 `lib/work-mcp.ts` 是 Cloudflare 实现，不是本次发布目标。服务器目标为 `ubuntu@124.222.83.113:/opt/game-team-board`。本任务未连接、部署或重启服务器。

## 集成

1. 将 `server/mcp_protocol.py` 放在正式 `server/app.py` 旁。
2. 参考 `patches/mcp-app.patch`：导入 `handle_post`，在 `/api/work-mcp` 完成现有 Bearer 身份校验后调用 `handle_post(self, member, TOOLS, call_tool)`；替换旧分派代码。GET 同路径返回 405（无 SSE）。若 app.py 同时新增网页 API，应只替换 MCP 分支，保留网页处理。
3. 使用主任务最终 app.py 运行测试，再由主任务统一部署。

模块不存储业务状态、不建第二套计时。注册表和处理函数仍来自 app.py。支持协议 `2025-03-26`、JSON 响应、batch、initialize、ping、tools/list、tools/call；通知返回 202 且不调用业务。未知工具/参数错误为 JSON-RPC 错误；业务拒绝为 `isError: true` 和 `ok: false`。输入校验覆盖现有注册表使用的类型、必填、枚举、长度、数值边界、额外属性；URI/UUID 的语义仍由业务处理负责，不宣称完整 JSON Schema 验证器。

MCP 浏览器 Origin 一律拒绝；员工网页使用自己的 API。原生 MCP 客户端不发送 Origin。服务应继续仅监听 localhost，由正式反向代理提供可信 HTTPS；禁止将 Bearer 直接配置到公网 HTTP。实际公开 URL 和 TLS 尚待主任务部署确认，不复用历史 sslip.io 地址。

## 身份与前缀

- 身份由服务端 `MCP_TOKEN_ZHC/YWT/YWH` 绑定，不接受工具参数改员工。未找到这三个缩写对应的正式中文姓名；网页首次姓名录入由主任务实现，不把显示姓名当成 MCP 身份认证。
- `todo`：首个独立 token 触发，私下澄清，生成 work 文本；不调用团队看板工具。
- `work`：确认拆分后登记，不自动开始；已有“加入并开始”授权可执行两步。保留单员工单项计时。
- `work_append_group_tasks`：员工发现漏拆后，向自己的已有大任务追加小任务；可同时调整未提交/未验收子任务的预计分钟。服务端保留历史计时和验收记录，最多 8 个子任务，使用 `request_id` 幂等重试。
- `hb`：仅查询后展示四选项。`hb 1/2/3/4` 带明确状态授权单次上传；不重复询问，不自动暂停，不编造百分比。
- `end`：整条消息精确匹配才表示本 work 对话全部完成。逐项对账后本地归档；不能把排队/阻塞任务假装完成。当前 finish 只接受进行中任务，遇到无法合法结束的任务必须报告未结束。
- 本地归档仍由已安装插件 `local_records.py` 执行；不上传项目文件、不新建重复提醒。

核实来源：已安装 game-team-work-tools 技能及员工包 source/AI_INSTALL.md。安装说明把 hb 简写为“开启提醒”，技能的实际约定为已有本地提醒检查服务端，本次不新增定时器。

## 验证

```sh
BOARD_APP_SOURCE=/absolute/path/to/current/server/app.py python3 -m unittest discover -s tests -v
```

测试导入指定 app.py、仅创建临时 SQLite 和 localhost 随机端口，使用测试专用身份。2026-09-09 三组通过：认证/握手/通知不写，畸形请求/参数，创建→开始→hb→暂停→继续→提交及跨员工隔离。当前业务代码出现 SQLite connection ResourceWarning，已通知主任务修复。

`tests/mcp_sdk_smoke.mjs` 已使用主 checkout 安装的官方 `@modelcontextprotocol/sdk` 对上述隔离服务验证 initialize→listTools→work_get_active→ping→close，当前工具数为 12。脚本仅适用于隔离测试地址，使用固定测试身份，不能对生产环境运行。

尚未验证：最终主任务 app.py 合并结果、腾讯云生产 MCP、员工 Codex 重启后工具发现、员工真实账户写入。现有插件/员工安装包可能保留旧地址，发布者应在不输出令牌的前提下更新连接 URL 并完成客户端发现。无需新建插件或改变共享凭证。

协议依据：[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)、[MCP Tools](https://modelcontextprotocol.io/specification/2025-03-26/server/tools)。
