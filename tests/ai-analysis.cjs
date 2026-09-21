const fs = require('node:fs');
const assert = require('node:assert');

const html = fs.readFileSync('server/static/index.html', 'utf8');
const js = fs.readFileSync('server/static/app.js', 'utf8');
const css = fs.readFileSync('server/static/styles.css', 'utf8');

assert.match(html, /id="nav-ai-analysis"/);
assert.match(html, /data-ai-prompt="today"/);
assert.match(html, /data-ai-prompt="week"/);
assert.match(html, /id="ai-chat-form"/);
assert.match(js, /ownerApi\('analysis-chat'/);
assert.match(js, /const pages = \[[^\]]*'ai-analysis'/);
assert.match(css, /\.ai-analysis-layout/);
assert.match(css, /@media\(max-width:560px\)/);

console.log('AI analysis owner interface checks passed');
