const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("server/static/index.html", "utf8");
const app = fs.readFileSync("server/static/app.js", "utf8");

assert.match(html, /服务器记录 · 可查看详情/);
assert.match(html, /id="people" class="people" aria-label="人员状态，可查看当前任务详情"/);
const peoplePanel = html.match(
  /<section class="panel">[\s\S]*?id="people"[\s\S]*?<\/section>/,
);
assert.ok(peoplePanel, "人员状态面板应存在");
assert.match(app, /data-person-task-id="\$\{esc\(p\.active\.id\)\}"/);
assert.match(app, /class="person-detail-link">查看任务详情 →/);
assert.match(app, /showDetail\(card\.dataset\.personTaskId\)/);

console.log("person status detail checks passed");
