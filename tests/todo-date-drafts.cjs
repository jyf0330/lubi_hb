const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("server/static/employee.html", "utf8");
const source = fs.readFileSync("server/static/employee.js", "utf8");

assert.match(html, /<h2>这周待办<\/h2>/);
assert.match(html, /id="todo-date"/);
assert.match(html, /本周周一至周五和下周一/);
assert.match(source, /function todoDates\(baseDate\)/);
assert.match(source, /todoStorageKey\(date\)/);
assert.match(source, /storage\(todoStorageKey\(todoDate\),e\.target\.value\)/);

const start = source.indexOf("function addDays");
const end = source.indexOf("function reworks", start);
const todoDates = vm.runInNewContext(`${source.slice(start, end)};todoDates`, {
  $: () => ({}),
});

assert.deepEqual(
  Array.from(todoDates("2026-09-16"), (item) => item.value),
  ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21"],
);
assert.deepEqual(
  Array.from(todoDates("2026-09-20"), (item) => item.value),
  ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21"],
);

console.log("TODO_DATE_DRAFTS_OK");
