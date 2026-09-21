const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('server/static/employee.html', 'utf8');
const source = fs.readFileSync('server/static/employee.js', 'utf8');

assert.match(html, /data-task-filter="unfinished"[^>]+aria-pressed="true"/);
assert.match(html, /data-task-filter="rework"/);
assert.match(html, /data-task-filter="review"/);
assert.match(html, /优先处理未完成与待修改/);

const start = source.indexOf('function employeeTaskCategory');
const end = source.indexOf('function renderEmployeeTaskBoard', start);
assert.ok(start >= 0 && end > start, '员工任务分类函数应存在');
const employeeTaskCategory = vm.runInNewContext(
  `${source.slice(start, end)}; employeeTaskCategory`,
);

assert.equal(employeeTaskCategory({status: '今日待办'}), 'unfinished');
assert.equal(employeeTaskCategory({status: '进行中'}), 'unfinished');
assert.equal(employeeTaskCategory({status: '阻塞'}), 'unfinished');
assert.equal(employeeTaskCategory({status: '需修改'}), 'rework');
assert.equal(employeeTaskCategory({status: '待验收'}), 'review');
assert.match(source, /group\.tasks\.filter\(task=>visibleIds\.has\(task\.id\)\)/);
assert.match(source, /当前没有待修改任务/);

console.log('EMPLOYEE_TASK_FILTERS_OK');
