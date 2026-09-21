const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('server/static/index.html', 'utf8');
const source = fs.readFileSync('server/static/app.js', 'utf8');

const start = source.indexOf('function isUnfinishedSubtask');
const end = source.indexOf('function meta', start);
assert.ok(start >= 0 && end > start, '未完成小任务判定函数应存在');

const isUnfinishedSubtask = vm.runInNewContext(
  `${source.slice(start, end)}; isUnfinishedSubtask`,
);

assert.equal(isUnfinishedSubtask({ group_id: 'group-1', status: '今日待办' }), true);
assert.equal(isUnfinishedSubtask({ group_id: 'group-1', status: '进行中' }), true);
assert.equal(isUnfinishedSubtask({ group_id: 'group-1', status: '待验收' }), true);
assert.equal(isUnfinishedSubtask({ group_id: 'group-1', status: '需修改' }), true);
assert.equal(isUnfinishedSubtask({ group_id: 'group-1', status: '阻塞' }), true);
assert.equal(isUnfinishedSubtask({ group_id: 'group-1', status: '已完成' }), false);
assert.equal(isUnfinishedSubtask({ group_id: 'group-1', status: '已关闭' }), false);
assert.equal(isUnfinishedSubtask({ group_id: null, status: '进行中' }), false);

assert.match(source, /tasks\.filter\(isUnfinishedSubtask\)\.length/);
assert.match(html, /仅统计大任务下的小任务/);
assert.match(html, /app\.js\?v=unfinished-subtasks-20260922/);

console.log('UNFINISHED_SUBTASK_COUNT_OK');
