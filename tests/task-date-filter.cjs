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

const lifecycleStart = source.indexOf("function taskLifecycleMeta");
const lifecycleEnd = source.indexOf("\nfunction checkinMeta", lifecycleStart);
assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart, "任务时间展示函数应存在");
const taskLifecycleMeta = vm.runInNewContext(
  `${source.slice(lifecycleStart, lifecycleEnd)};taskLifecycleMeta`,
  {
    shanghaiDate: (timestamp) => `日期${timestamp}`,
    clock: (timestamp) => `时间${timestamp}`,
  },
);
assert.equal(
  taskLifecycleMeta({
    time_sessions: [{ started_at: 300 }, { started_at: 100 }, { started_at: 200 }],
    first_submitted_at: 400,
    submitted_at: 500,
  }),
  "开始工作时间：日期100 时间100 · 首次提交时间：日期400 时间400",
);
assert.equal(
  taskLifecycleMeta({ time_sessions: [], submitted_at: null }),
  "开始工作时间：未开始 · 首次提交时间：未提交",
);
assert.match(source, /task-lifecycle[\s\S]*taskLifecycleMeta\(t\)/);

console.log("TASK_DATE_FILTER_OK");
