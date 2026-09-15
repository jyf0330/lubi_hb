export const MEMBERS = ['ZHC', 'YWT'] as const;
export const TASK_TYPES = [
  '美术',
  '测试',
  '文档',
  '配置',
  '资料整理',
  'AI任务',
  '其他',
] as const;
export const TASK_STATUSES = [
  '任务池',
  '今日待办',
  '进行中',
  '待验收',
  '需修改',
  '已完成',
  '阻塞',
] as const;
export const TASK_ACTIONS = [
  'claim',
  'start',
  'pause',
  'resume',
  'submit',
  'accept',
  'rework',
  'block',
  'unblock',
] as const;

export type Member = (typeof MEMBERS)[number];
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskAction = (typeof TASK_ACTIONS)[number];

export type TransitionTask = {
  assignee: Member | null;
  status: TaskStatus;
  isPaused: boolean;
};

export function plannedPoints(estimatedMinutes: number) {
  return Math.round((estimatedMinutes / 60) * 2) / 2;
}

export function assertTransition(
  task: TransitionTask,
  action: TaskAction,
  actor: Member,
) {
  if (action === 'claim') {
    if (task.status !== '任务池' || task.assignee) {
      throw new Error('只有任务池中的未领取任务可以领取。');
    }
    return;
  }

  if (
    ['start', 'pause', 'resume', 'submit', 'block', 'unblock'].includes(action)
  ) {
    if (!task.assignee || task.assignee !== actor) {
      throw new Error('只有任务负责人可以执行此操作。');
    }
  }

  const valid =
    (action === 'start' && ['今日待办', '需修改'].includes(task.status)) ||
    (action === 'pause' && task.status === '进行中' && !task.isPaused) ||
    (action === 'resume' && task.status === '进行中' && task.isPaused) ||
    (action === 'submit' && task.status === '进行中') ||
    (action === 'accept' && task.status === '待验收') ||
    (action === 'rework' && task.status === '待验收') ||
    (action === 'block' && !['已完成', '阻塞'].includes(task.status)) ||
    (action === 'unblock' && task.status === '阻塞');

  if (!valid) throw new Error(`任务状态“${task.status}”不能执行该操作。`);
}
