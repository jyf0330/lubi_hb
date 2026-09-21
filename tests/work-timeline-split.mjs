import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("server/static/app.js", "utf8");
const css = fs.readFileSync("server/static/styles.css", "utf8");
const html = fs.readFileSync("server/static/index.html", "utf8");

// 工作轨迹固定按两名员工分栏，负责人本人不混入员工轨迹。
assert.match(app, /const TIMELINE_EMPLOYEES = \["ZHC", "YWT"\]/);
assert.match(app, /TIMELINE_EMPLOYEES\.map\(\(id\) =>/);
assert.match(app, /events\.filter\(\(item\) => item\.assignee === id\)/);
assert.match(app, /timelineAttention\(tasks,date,id\)/);
assert.match(html, /id="timeline-people" class="timeline-people-grid"/);
assert.match(html, /赵浩丞与余文滔的独立工作轨迹/);
assert.doesNotMatch(html, /id="timeline-person"/);
assert.doesNotMatch(html, /统一工作记录/);
assert.match(css, /\.timeline-people-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.match(css, /@media\(max-width:1100px\)\{\.timeline-people-grid\{grid-template-columns:1fr\}/);

console.log("split work timeline checks passed");
