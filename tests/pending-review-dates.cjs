const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("server/static/app.js", "utf8");
const start = source.indexOf("function renderPendingReviews");
const end = source.indexOf("\nfunction timeDetails", start);
assert.ok(start >= 0 && end > start, "待审核日期分组函数应存在");

const { renderPendingReviews } = vm.runInNewContext(
  `${source.slice(start, end)};({ renderPendingReviews })`,
  {
    esc: (value) => String(value ?? ""),
    names: { ZHC: "赵浩丞", YWT: "余文滔" },
    meta: () => "任务说明",
    shanghaiDate: (ms) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(ms)),
  },
);

const dateOne = Date.parse("2026-09-14T09:45:00+08:00");
const dateTwo = Date.parse("2026-09-15T10:15:00+08:00");
const html = renderPendingReviews([
  {
    id: "resubmitted",
    title: "返工后重提",
    assignee: "ZHC",
    first_submitted_at: dateOne,
    submitted_at: dateTwo,
  },
  {
    id: "newer",
    title: "新提交",
    assignee: "YWT",
    first_submitted_at: dateTwo,
    submitted_at: dateTwo,
  },
  { id: "legacy", title: "历史待审核", assignee: "ZHC" },
]);

assert.ok(html.indexOf("2026-09-15 首次提交") < html.indexOf("2026-09-14 首次提交"));
const firstDateGroup = html.slice(
  html.indexOf("2026-09-14 首次提交"),
  html.indexOf("提交日期未知"),
);
assert.match(firstDateGroup, /返工后重提/);
assert.doesNotMatch(firstDateGroup, /新提交/);
assert.match(html, /提交日期未知/);

console.log("PENDING_REVIEW_DATES_OK");
