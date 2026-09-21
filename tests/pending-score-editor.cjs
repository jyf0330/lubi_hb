const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("server/static/employee.js", "utf8");
const page = fs.readFileSync("server/static/employee.html", "utf8");
const start = source.indexOf("function renderPendingReviewScores");
const end = source.indexOf("function renderTodayScoreDetails", start);
assert.ok(start >= 0 && end > start, "待验收积分渲染函数应存在");

const nodes = {
  "#pending-score-count": {},
  "#pending-score-total": {},
  "#pending-score-list": {},
};
const renderPendingReviewScores = vm.runInNewContext(
  `${source.slice(start, end)}; renderPendingReviewScores`,
  {
    $: (selector) => nodes[selector],
    esc: (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]),
    Map,
    Number,
  },
);

renderPendingReviewScores([
  {id: "a", title: "草图", status: "待验收", group_id: "g", employee_ai_points: 2, result_summary: "完成草图"},
  {id: "b", title: "导出", status: "待验收", group_id: "g", employee_ai_points: 3, result_summary: "完成导出"},
  {id: "c", title: "仍在制作", status: "进行中", employee_ai_points: 100},
], [{id: "g", title: "角色制作"}]);

assert.equal(nodes["#pending-score-count"].textContent, 2);
assert.equal(nodes["#pending-score-total"].textContent, "申请合计 5 点");
assert.match(nodes["#pending-score-list"].innerHTML, /大任务 · 角色制作/);
assert.match(nodes["#pending-score-list"].innerHTML, /草图/);
assert.match(nodes["#pending-score-list"].innerHTML, /2 点/);
assert.match(nodes["#pending-score-list"].innerHTML, /data-edit-submission="a"/);
assert.doesNotMatch(nodes["#pending-score-list"].innerHTML, /仍在制作/);

assert.match(page, /id="tab-pending-scores"/);
assert.match(page, /id="pending-scores"[^>]+role="tabpanel"/);
assert.match(page, /最终得分以负责人验收结果为准/);
assert.match(page, /id="submission-edit-dialog"/);
assert.match(source, /work_update_submission/);

console.log("PENDING_SCORE_EDITOR_OK");
