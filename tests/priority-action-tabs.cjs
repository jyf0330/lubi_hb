const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("server/static/index.html", "utf8");
const source = fs.readFileSync("server/static/app.js", "utf8");

const tabs = [...html.matchAll(/data-action-status="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(tabs, ["待验收", "阻塞", "需修改"]);
assert.match(html, /role="tablist" aria-label="优先关注分类"/);
assert.match(html, /id="actions" class="actions" role="tabpanel"/);
assert.match(source, /event\.key === "ArrowRight"/);

const helperStart = source.indexOf("function collectPriorityActionSections");
const helperEnd = source.indexOf("function renderPriorityActionStatus", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "分类汇总函数应存在");
const collectPriorityActionSections = vm.runInNewContext(
  `${source.slice(helperStart, helperEnd)}; collectPriorityActionSections`,
  { PRIORITY_STATUSES: ["待验收", "阻塞", "需修改"] },
);

const group = {
  id: "g1",
  title: "版本交付",
  tasks: [
    { id: "pending", status: "待验收", title: "验收中的子任务" },
    { id: "blocked", status: "阻塞", title: "阻塞的子任务" },
    { id: "rework", status: "需修改", title: "返工的子任务" },
  ],
  ready_for_acceptance: false,
};
const tasks = [
  ...group.tasks,
  { id: "standalone", status: "待验收", title: "独立任务" },
];
let sections = collectPriorityActionSections(tasks, [group]);
assert.deepEqual(Array.from(sections["待验收"], (entry) => entry.key), ["task:standalone"]);
assert.deepEqual(Array.from(sections["阻塞"], (entry) => entry.tasks[0].id), ["blocked"]);
assert.deepEqual(Array.from(sections["需修改"], (entry) => entry.tasks[0].id), ["rework"]);

sections = collectPriorityActionSections(tasks, [{ ...group, ready_for_acceptance: true }]);
assert.deepEqual(Array.from(sections["待验收"], (entry) => entry.key), ["group:g1", "task:standalone"]);
assert.equal(sections["待验收"][0].ready, true);

console.log("PRIORITY_ACTION_TABS_OK");
