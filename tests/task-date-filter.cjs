const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("server/static/index.html", "utf8");
const source = fs.readFileSync("server/static/app.js", "utf8");
assert.match(html, /id="date-filter" type="date"/);
assert.match(source, /data\.all_tasks \|\| data\.tasks/);

const start = source.indexOf("function taskMatchesFilters");
const end = source.indexOf("function renderTasks", start);
assert.ok(start >= 0 && end > start, "日期筛选函数应存在");
const taskMatchesFilters = vm.runInNewContext(
  `${source.slice(start, end)};taskMatchesFilters`,
);

const base = { assignee: "ZHC", status: "进行中", planned_date: "2026-09-18", title: "素材整理", group_title: "" };
assert.equal(taskMatchesFilters(base, { owner: "", status: "", date: "2026-09-18", search: "" }), true);
assert.equal(taskMatchesFilters(base, { owner: "", status: "", date: "2026-09-19", search: "" }), false);
assert.equal(taskMatchesFilters({ ...base, planned_date: null }, { owner: "", status: "", date: "", search: "" }), true);
assert.equal(taskMatchesFilters(base, { owner: "", status: "", date: "2026-09-18", search: "素材" }), true);

console.log("TASK_DATE_FILTER_OK");
