PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  assignee TEXT NOT NULL CHECK (assignee IN ('ZHC', 'YWT')),
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '其他',
  status TEXT NOT NULL DEFAULT '今日待办',
  priority TEXT NOT NULL DEFAULT '普通',
  planned_date TEXT,
  deadline_at INTEGER,
  estimated_minutes INTEGER NOT NULL,
  planned_points REAL NOT NULL,
  deliverable_expectation TEXT,
  acceptance_criteria TEXT,
  result_summary TEXT,
  acceptance_result TEXT,
  blocked_reason TEXT,
  notes TEXT,
  rework_count INTEGER NOT NULL DEFAULT 0,
  is_paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_planned_date ON tasks (assignee, planned_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated_at ON tasks (status, updated_at);

CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  assignee TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_work_sessions_task_id ON work_sessions (task_id);
CREATE INDEX IF NOT EXISTS idx_work_sessions_assignee_started_at ON work_sessions (assignee, started_at);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON task_events (task_id, created_at);

CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL DEFAULT '链接',
  label TEXT,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliverables_task_id ON deliverables (task_id);
PRAGMA optimize;
