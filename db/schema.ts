import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    assignee: text('assignee', { enum: ['ZHC', 'YWT'] }),
    title: text('title').notNull(),
    type: text('type', {
      enum: ['美术', '测试', '文档', '配置', '资料整理', 'AI任务', '其他'],
    })
      .notNull()
      .default('其他'),
    status: text('status', {
      enum: [
        '任务池',
        '今日待办',
        '进行中',
        '待验收',
        '需修改',
        '已完成',
        '阻塞',
      ],
    })
      .notNull()
      .default('今日待办'),
    priority: text('priority', { enum: ['低', '普通', '高', '紧急'] })
      .notNull()
      .default('普通'),
    plannedDate: text('planned_date'),
    deadlineAt: integer('deadline_at', { mode: 'timestamp_ms' }),
    estimatedMinutes: integer('estimated_minutes').notNull(),
    plannedPoints: real('planned_points').notNull(),
    deliverableExpectation: text('deliverable_expectation'),
    acceptanceCriteria: text('acceptance_criteria'),
    resultSummary: text('result_summary'),
    acceptanceResult: text('acceptance_result'),
    blockedReason: text('blocked_reason'),
    notes: text('notes'),
    artProgressUrl: text('art_progress_url'),
    artFinalUrl: text('art_final_url'),
    artSourceUrl: text('art_source_url'),
    testPlannedCases: integer('test_planned_cases'),
    testActualCases: integer('test_actual_cases'),
    testNewBugs: integer('test_new_bugs'),
    testValidBugs: integer('test_valid_bugs'),
    testRegressionBugs: integer('test_regression_bugs'),
    testSevereBugs: integer('test_severe_bugs'),
    reworkCount: integer('rework_count').notNull().default(0),
    isPaused: integer('is_paused', { mode: 'boolean' })
      .notNull()
      .default(false),
    claimedAt: integer('claimed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('idx_tasks_assignee_planned_date').on(
      table.assignee,
      table.plannedDate,
    ),
    index('idx_tasks_planned_date').on(table.plannedDate),
    index('idx_tasks_status_updated_at').on(table.status, table.updatedAt),
  ],
);

export const workSessions = sqliteTable(
  'work_sessions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    assignee: text('assignee', { enum: ['ZHC', 'YWT'] }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    endReason: text('end_reason', { enum: ['暂停', '提交', '阻塞', '修正'] }),
  },
  (table) => [
    index('idx_work_sessions_task_id').on(table.taskId),
    index('idx_work_sessions_assignee_started_at').on(
      table.assignee,
      table.startedAt,
    ),
  ],
);

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    actor: text('actor').notNull(),
    eventType: text('event_type').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    detail: text('detail'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('idx_task_events_task_created').on(table.taskId, table.createdAt),
  ],
);

export const deliverables = sqliteTable(
  'deliverables',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    kind: text('kind').notNull().default('链接'),
    label: text('label'),
    url: text('url').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('idx_deliverables_task_id').on(table.taskId)],
);

export const taskAttachments = sqliteTable(
  'task_attachments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('idx_task_attachments_task_id').on(table.taskId)],
);
