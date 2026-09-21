PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  assignee TEXT NOT NULL CHECK (assignee IN ('ZHC', 'YWT', 'YWH')),
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
  variance_reason TEXT,
  notes TEXT,
  rework_count INTEGER NOT NULL DEFAULT 0,
  is_paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER,
  completed_at INTEGER,
  first_submitted_at INTEGER,
  first_submitted_points REAL,
  deleted_from_status TEXT,
  deleted_at INTEGER,
  deleted_by TEXT
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

CREATE TABLE IF NOT EXISTS progress_updates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT NOT NULL REFERENCES work_sessions(id),
  assignee TEXT NOT NULL,
  report_status TEXT NOT NULL DEFAULT '正常推进',
  summary TEXT NOT NULL,
  next_step TEXT,
  blocker TEXT,
  progress_percent INTEGER CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_progress_updates_task_created ON progress_updates (task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_progress_updates_assignee_created ON progress_updates (assignee, created_at);

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

CREATE TABLE IF NOT EXISTS task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  body BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id);

CREATE TABLE IF NOT EXISTS progress_images (
  id TEXT PRIMARY KEY,
  progress_id TEXT NOT NULL REFERENCES progress_updates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  body BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_images_report ON progress_images(progress_id);

CREATE TABLE IF NOT EXISTS progress_attachments (
  id TEXT PRIMARY KEY,
  progress_id TEXT NOT NULL REFERENCES progress_updates(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  body BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_attachments_report ON progress_attachments(progress_id);

CREATE TABLE IF NOT EXISTS daily_reports (
  id TEXT PRIMARY KEY,
  assignee TEXT NOT NULL CHECK (assignee IN ('ZHC', 'YWT', 'YWH')),
  report_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (assignee, report_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports (report_date, assignee);

CREATE TABLE IF NOT EXISTS board_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
PRAGMA optimize;
