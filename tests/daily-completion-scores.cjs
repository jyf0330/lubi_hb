const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("server/static/app.js", "utf8");
const page = fs.readFileSync("server/static/index.html", "utf8");
const start = source.indexOf("function renderScoreHistory");
const end = source.indexOf("async function ownerApi", start);
assert.ok(start >= 0 && end > start, "每日完成与得分渲染函数应存在");

const containers = {
  "#daily-completion-scores": { innerHTML: "" },
  "#score-history": { innerHTML: "" },
};
const renderScoreHistory = vm.runInNewContext(
  `${source.slice(start, end)}; renderScoreHistory`,
  {
    document: { querySelector: (selector) => containers[selector] },
    names: { ZHC: "赵浩丞", YWT: "余文滔", YWH: "余文浩" },
    esc: (value) => String(value ?? ""),
    formatPoints: (value) => String(Number(value)),
    shanghaiDate: () => "2026-09-21",
    clock: () => "16:30",
  },
);

renderScoreHistory(
  [
    { date: "2026-09-21", assignee: "ZHC", points: 5, completed_count: 2, unscored_count: 0 },
    { date: "2026-09-21", assignee: "YWT", points: 0, completed_count: 0, unscored_count: 0 },
    { date: "2026-09-21", assignee: "YWH", points: 0, completed_count: 0, unscored_count: 0 },
  ],
  [
    { id: "a", title: "草图", assignee: "ZHC", status: "已完成", group_title: "角色制作", awarded_points: 2, completed_at: 1 },
    { id: "b", title: "导出", assignee: "ZHC", status: "已完成", group_title: "角色制作", awarded_points: 3, completed_at: 2 },
  ],
  [{ date: "2026-09-21", assignee: "ZHC", points: 7, unscored_count: 0 }],
  "2026-09-21",
);

const daily = containers["#daily-completion-scores"].innerHTML;
assert.match(daily, /2026-09-21/);
assert.match(daily, /2 项 · 5 点/);
assert.match(daily, /小任务 · 所属大任务：角色制作/);
assert.match(daily, /草图/);
assert.match(daily, /2 点/);
assert.match(daily, /导出/);
assert.match(daily, /3 点/);
assert.doesNotMatch(daily, /角色制作<\/b>.*5 点/);
assert.match(daily, /大任务只负责归类与汇总，不单独计分/);
assert.match(containers["#score-history"].innerHTML, /7 点/);
assert.match(page, /大任务只是小任务的汇总，不会额外叠加一遍分数/);
assert.match(page, /id="daily-completion-scores"/);

console.log("DAILY_COMPLETION_SCORES_OK");
