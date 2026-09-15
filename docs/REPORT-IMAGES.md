# hb 汇报图片

正式 Python/SQLite 服务的员工页支持在「hb · 汇报进展」选择图片、预览、移除，并随文字一起提交。个人历史和负责人 hb 列表提供缩略图及原图链接。文字汇报仍可单独提交。

- 支持 PNG、JPEG、WebP；最多 6 张，单张原图 4 MiB，合计 12 MiB。浏览器提交前用 Canvas 将图片最长边缩到 1600 像素并优先转 WebP（质量 0.82，必要时 JPEG），只有压缩结果更小时才替换原图，避免无谓放大；服务端独立检查数量、Base64、文件签名和大小，不采信客户端 MIME。仅允许栅格图片，不支持 SVG。签名检查不等同于完整图片解码验证。
- 图片 BLOB 位于同一 SQLite 数据库的 `progress_images`，外键关联 `progress_updates`。汇报与所有图片在同一事务内提交；任意图片不合格则整次回滚。原有数据库启动时自动增建该表，不迁移或覆盖历史记录。备份数据库即包含图片。
- 新接口 `POST /api/employee/heartbeat` 复用员工 Cookie、请求头和正式任务所有权检查，最大 JSON 请求 17 MiB；其他员工接口保留 64 KiB 限制。
- `GET /api/report-images/{id}` 仅允许汇报作者与已登录负责人查看，响应为服务端确定的图片 MIME、`nosniff` 和 `no-store`。负责人需先从员工入口登录后查看看板图片。保留现有登录体系，本次不更改其认证方式。
- 提交期间禁用汇报表单；失败保留本页文字及图片，成功释放预览资源。页面刷新或退出登录会清除未提交的图片草稿。

## 发布范围与恢复

发布 `server/app.py`、`server/schema.sql`、`server/report_images.py`，以及本次修改的员工与负责人 HTML/JS、新增 `report-images.js` 和 `report-images.css`。保留当前正式服务、目录、数据库路径；不发布旧 Vinext/D1 原型。

上线前备份当前服务文件与数据库；在现有 `/team-board/` 的 nginx 代理 location 内添加 `client_max_body_size 17m;`（不要改其他站点），验证 nginx 配置后重载，再重启本项目服务。仅修改本地源码不会更改线上请求限制。

回退时恢复备份的应用文件与 nginx 配置；新增图片表可保留，旧版本会忽略它。不要用旧数据库覆盖上线后产生的新汇报。

验证：`python3 -m unittest discover -s tests -p 'test_*.py'`，`node tests/report-images.cjs`，现有前端测试及 JavaScript 语法检查。网络与浏览器的实际发布验收需在获得上线授权后进行。
