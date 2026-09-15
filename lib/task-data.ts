import { env } from 'cloudflare:workers';
import type { Member, TaskStatus, TaskType } from './task-domain';

export type TaskRow = {
  id: string;
  assignee: Member | null;
  title: string;
  type: TaskType;
  status: TaskStatus;
  priority: '低' | '普通' | '高' | '紧急';
  planned_date: string | null;
  estimated_minutes: number;
  planned_points: number;
  deliverable_expectation: string | null;
  acceptance_criteria: string | null;
  result_summary: string | null;
  acceptance_result: string | null;
  blocked_reason: string | null;
  notes: string | null;
  art_progress_url: string | null;
  art_final_url: string | null;
  art_source_url: string | null;
  test_planned_cases: number | null;
  test_actual_cases: number | null;
  test_new_bugs: number | null;
  test_valid_bugs: number | null;
  test_regression_bugs: number | null;
  test_severe_bugs: number | null;
  rework_count: number;
  is_paused: number;
  claimed_at: number | null;
  submitted_at: number | null;
  completed_at: number | null;
  updated_at: number;
};

export type SessionRow = {
  assignee: Member;
  title: string;
  started_at: number;
  ended_at: number | null;
};

export type TaskAttachmentRow = {
  id: string;
  task_id: string;
  name: string;
  content_type: string;
  size: number;
  storage_key: string;
  created_at: number;
  url?: string;
};

export function getD1() {
  if (!env.DB) throw new Error('SQLite 数据库绑定 DB 不可用。');
  return env.DB;
}

export async function getTaskById(taskId: string) {
  return getD1()
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<TaskRow>();
}

export async function getTaskAttachment(taskId: string, attachmentId: string) {
  return getD1()
    .prepare('SELECT * FROM task_attachments WHERE task_id = ? AND id = ?')
    .bind(taskId, attachmentId)
    .first<TaskAttachmentRow>();
}

export async function getTaskAttachments(taskId: string) {
  const result = await getD1()
    .prepare(
      `SELECT id, task_id, name, content_type, size, storage_key, created_at
       FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC`,
    )
    .bind(taskId)
    .all<TaskAttachmentRow>();
  return result.results;
}

export async function getBoardData(today: string) {
  const db = getD1();
  const [taskResult, sessionResult, nowRow] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = '任务池' OR planned_date = ?
         ORDER BY CASE priority WHEN '紧急' THEN 0 WHEN '高' THEN 1 WHEN '普通' THEN 2 ELSE 3 END,
                  updated_at DESC`,
      )
      .bind(today)
      .all<TaskRow>(),
    db
      .prepare(
        `SELECT ws.assignee, t.title, ws.started_at, ws.ended_at
         FROM work_sessions ws JOIN tasks t ON t.id = ws.task_id
         WHERE t.planned_date = ? ORDER BY ws.started_at DESC LIMIT 16`,
      )
      .bind(today)
      .all<SessionRow>(),
    db
      .prepare(`SELECT CAST(unixepoch('now') * 1000 AS INTEGER) AS now_ms`)
      .first<{ now_ms: number }>(),
  ]);

  return {
    tasks: taskResult.results,
    sessions: sessionResult.results,
    now: Number(nowRow?.now_ms ?? Date.now()),
  };
}

export function taskEvent(
  taskId: string,
  actor: string,
  eventType: string,
  fromStatus: string | null,
  toStatus: string | null,
  detail: string | null,
  now: number,
) {
  return getD1()
    .prepare(
      `INSERT INTO task_events
       (id, task_id, actor, event_type, from_status, to_status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      taskId,
      actor,
      eventType,
      fromStatus,
      toStatus,
      detail,
      now,
    );
}
