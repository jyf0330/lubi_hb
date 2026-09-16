const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("server/static/index.html", "utf8");
const app = fs.readFileSync("server/static/app.js", "utf8");

assert.match(html, /服务器记录 · 只读/);
assert.match(html, /id="people" class="people" aria-label="人员状态，只读概览"/);
const peoplePanel = html.match(
  /<section class="panel">[\s\S]*?id="people"[\s\S]*?<\/section>/,
);
assert.ok(peoplePanel, "人员状态面板应存在");
assert.doesNotMatch(
  peoplePanel[0],
  /<(?:button|a)\b/,
  "人员状态面板应保持为只读容器，不添加按钮或链接",
);
assert.match(app, /<article class="person /);
assert.doesNotMatch(
  app,
  /getElementById\(["']people["']\)\.(?:onclick|addEventListener)/,
  "人员状态不应绑定点击详情事件",
);

console.log("person status readonly checks passed");
