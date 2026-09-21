const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("server/static/employee.js", "utf8");
const page = fs.readFileSync("server/static/employee.html", "utf8");
const start = source.indexOf("function renderTodayScoreDetails");
const end = source.indexOf("function renderEmployeeReminders", start);
assert.ok(start >= 0 && end > start, "今日得分明细渲染函数应存在");

const renderTodayScoreDetails = vm.runInNewContext(
  `${source.slice(start, end)}; renderTodayScoreDetails`,
  {
    esc: (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]),
  },
);

assert.match(renderTodayScoreDetails([]), /今天还没有审核通过的任务/);

const html = renderTodayScoreDetails([
  { id: "a", title: "草图", group_id: "g", group_title: "角色制作", awarded_points: 2 },
  { id: "b", title: "导出", group_id: "g", group_title: "角色制作", awarded_points: 3 },
  { id: "c", title: "整理文档", group_id: null, group_title: null, awarded_points: 1 },
]);
assert.match(html, /大任务 · 角色制作/);
assert.match(html, /小任务 · 草图/);
assert.match(html, /小任务 · 导出/);
assert.match(html, /独立任务/);
assert.match(html, /整理文档/);
assert.equal((html.match(/2 点|3 点|1 点/g) || []).length, 3);
assert.doesNotMatch(html, /<strong>5 点<\/strong>/);
assert.match(source, /data-open-today-score[\s\S]*?showModal\(\)/);
assert.match(page, /<dialog id="today-score-dialog" aria-labelledby="today-score-heading">/);
assert.match(page, /<button id="close-today-score" type="button">关闭<\/button>/);
assert.doesNotMatch(page, /class="today-score-details"/);

console.log("TODAY_SCORE_DETAILS_OK");
