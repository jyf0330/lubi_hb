const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboardHtml = fs.readFileSync('server/static/index.html', 'utf8');
const dashboardJs = fs.readFileSync('server/static/app.js', 'utf8');
const employeeHtml = fs.readFileSync('server/static/employee.html', 'utf8');
const employeeJs = fs.readFileSync('server/static/employee.js', 'utf8');

assert.match(dashboardHtml, /id="data-freeze-form"/);
assert.match(dashboardHtml, /name="freeze_date" type="date"/);
assert.match(dashboardHtml, /更早记录不会删除/);
assert.match(dashboardJs, /ownerApi\('freeze',\{freeze_date:freezeDate\}\)/);
assert.match(dashboardJs, /工作台只显示/);
assert.match(employeeHtml, /id="employee-freeze-banner"/);
assert.match(employeeJs, /data\.freeze_date/);
assert.match(employeeJs, /option\.value>=freezeBoundary/);

console.log('DATA_FREEZE_UI_OK');
