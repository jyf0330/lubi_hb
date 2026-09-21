const assert = require("node:assert/strict");
const fs = require("node:fs");

const app = fs.readFileSync("server/static/app.js", "utf8");
const css = fs.readFileSync("server/static/styles.css", "utf8");
const html = fs.readFileSync("server/static/index.html", "utf8");

// 任务详情：短字段 chip 行 + 长文本双列折叠 + 右栏审核表单，目标是一屏看完。
assert.match(app, /class="detail-main"/);
assert.match(app, /class="detail-chips">/);
assert.match(app, /class="detail-chip"><b>/);
assert.match(app, /class="detail-fields">/);
assert.match(app, /class="detail-field"><dt>/);
assert.match(app, /<aside class="detail-side" id="detail-side">/);
assert.match(app, /content\.classList\.toggle\('has-review',canReview\|\|canClose\|\|canEditScore\)/);
assert.match(app, /function clampDetailFields\(\)/);
assert.match(app, /classList\.add\('is-clamped'\)/);
assert.match(app, /'展开全文'/);
assert.match(
  app,
  /querySelector\('#task-detail'\)\.showModal\(\);\s*\n\s*clampDetailFields\(\);/,
);
// 待验收任务及负责人可关闭的阻塞/返工任务显示右栏，其他状态单栏满宽。
assert.match(app, /\(canReview\|\|canClose\|\|canEditScore\?'<aside class="detail-side" id="detail-side"><\/aside>':''\)/);
assert.match(app, /function appendScoreEditForm\(t\)/);
assert.match(app, /action:'owner_set_task_score'/);
assert.match(app, /class="timeline-event kind-\$\{item\.type\}" data-task-id="\$\{esc\(item\.task_id\)\}"/);
assert.match(app, /'progress-pending','timeline-people'\]\)document\.getElementById\(id\)\.onclick/);
// 审核表单必须落在右栏容器内，而不是直接塞进 #detail-content。
assert.match(
  app,
  /const container=document\.querySelector\('#detail-side'\)\|\|document\.querySelector\('#detail-content'\);/,
);
assert.doesNotMatch(app, /detail-field-wide/);

assert.match(css, /#task-detail\s*\{[^}]*width:\s*min\(1080px/);
assert.match(css, /#detail-content\.has-review\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.5fr\)/);
assert.match(css, /\.detail-fields dd\.is-clamped\s*\{[^}]*line-clamp:\s*3/);
assert.match(css, /\.detail-expand\s*\{/);
assert.match(css, /\.timeline-event:hover\s*\{/);
assert.match(css, /@media \(max-width: 900px\)\s*\{\s*#detail-content\.has-review\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);

// 静态资源缓存键必须随改动更新，否则浏览器会继续用旧缓存。
// 不锁定具体取值，避免与其他并行改动抢同一行。
assert.match(html, /styles\.css\?v=[\w.-]+/);
assert.match(html, /app\.js\?v=[\w.-]+/);
assert.doesNotMatch(html, /styles\.css\?v=score-detail-20260917/);
assert.doesNotMatch(html, /app\.js\?v=report-date-20260918/);

console.log("detail layout checks passed");
