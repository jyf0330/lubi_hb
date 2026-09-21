const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("server/static/index.html", "utf8");
const source = fs.readFileSync("server/static/app.js", "utf8");

// The owner only reviews a big task after every child is submitted, then can
// accept the whole group in one click using the employees' suggested total.
assert.match(source, /action:'owner_review_group'/);
assert.match(source, /status !== "待验收" \|\| ready/);
assert.match(source, /员工建议合计|员工建议总分/);
assert.match(html, /一次验收/);

const cardStart = source.indexOf("function renderActionCard");
const groupStart = source.indexOf("function renderActionGroup", cardStart);
const groupEnd = source.indexOf("function taskMatchesFilters", groupStart);
assert.ok(cardStart >= 0 && groupStart > cardStart && groupEnd > groupStart, "大任务渲染函数应存在");
const slice = `${source.slice(cardStart, groupStart)}${source.slice(groupStart, groupEnd)};({renderActionCard,renderActionGroup})`;
const { renderActionGroup } = vm.runInNewContext(slice, {
  esc: (value) => String(value ?? ""),
  names: { ZHC: "赵浩丞", YWT: "余文滔", YWH: "余文浩" },
  statuses: ["今日待办", "进行中", "待验收", "需修改", "已完成", "阻塞"],
  formatPoints: (points) => Number(points).toLocaleString("zh-CN", { maximumFractionDigits: 2 }),
  ownerLoggedIn: true,
  meta: () => "说明",
});

const child = { id: "t1", status: "待验收", title: "阶段规划", assignee: "ZHC" };
const group = {
  id: "g1",
  title: "制作像素素材",
  assignee: "ZHC",
  status: "待验收",
  total_count: 3,
  suggested_points: 6,
  suggested_complete: true,
  ready_for_acceptance: true,
};

const readyHtml = renderActionGroup(group, [child], true);
assert.match(readyHtml, /员工建议总分 <strong>6 点<\/strong>/);
assert.match(readyHtml, /data-group-review="g1"/);
assert.match(readyHtml, /一次验收大任务（6 点）/);
assert.doesNotMatch(readyHtml, /disabled/);

const partialHtml = renderActionGroup({ ...group, status: "进行中" }, [child], false);
assert.doesNotMatch(partialHtml, /data-group-review/);
assert.doesNotMatch(partialHtml, /员工建议总分/);

const missingHtml = renderActionGroup({ ...group, suggested_complete: false }, [child], true);
assert.match(missingHtml, /部分小任务未填自评分/);
assert.match(missingHtml, /disabled/);

console.log("GROUP_ACCEPTANCE_OK");
