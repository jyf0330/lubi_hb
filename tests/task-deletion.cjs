const assert = require('node:assert/strict');
const fs = require('node:fs');

const employeeHtml = fs.readFileSync('server/static/employee.html', 'utf8');
const employeeJs = fs.readFileSync('server/static/employee.js', 'utf8');
const ownerHtml = fs.readFileSync('server/static/index.html', 'utf8');
const ownerJs = fs.readFileSync('server/static/app.js', 'utf8');

assert.match(employeeJs, /button\('work_delete_task','删除任务'\)/);
assert.match(employeeJs, /data-delete-task/);
assert.match(employeeJs, /只有管理员能在删除区查看和恢复/);
assert.doesNotMatch(employeeHtml, /id="deleted"/);

assert.match(ownerHtml, /id="nav-deleted"[^>]+hidden/);
assert.match(ownerHtml, /data-deleted-filter="pending"/);
assert.match(ownerHtml, /data-deleted-filter="accepted"/);
assert.match(ownerHtml, />待修改</);
assert.match(ownerHtml, />已经验收</);
assert.match(ownerJs, /deleted_from_status==='已完成'\?'accepted':'pending'/);
assert.match(ownerJs, /action:'owner_restore_task'/);
assert.match(ownerJs, /#nav-deleted/);

console.log('TASK_DELETION_UI_OK');
