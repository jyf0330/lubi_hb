#!/usr/bin/env python3
from __future__ import annotations

import workflow
import report_images
import report_files
import task_files
import argparse
import hmac
import json
import os
import sqlite3
import threading
import time
import uuid
import secrets
import hashlib
from http.cookies import SimpleCookie
from datetime import datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from zoneinfo import ZoneInfo
from mcp_protocol import handle_post
from task_planner import generate_score, generate_plan, validate_plan, text as plan_text
from team_analyst import generate_analysis

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
SCHEMA = ROOT / "schema.sql"
TASK_TYPES = ["美术", "测试", "文档", "配置", "资料整理", "AI任务", "其他"]
DB_PATH = Path("tasks.db")
DB_LOCK = threading.RLock()
MEMBERS = ("ZHC", "YWT", "YWH")
EMPLOYEE_NAMES = {"赵浩丞": "ZHC", "余文滔": "YWT", "余文浩": "YWH"}
VARIANCE_REASONS = ("需求变化", "技术问题", "素材等待", "返工", "估时偏差", "其他")
HEARTBEAT_STATUSES = ("正常推进", "已完成阶段", "遇到问题", "计划调整")
CHECKIN_INTERVAL_MS = 30 * 60 * 1000
SHANGHAI = ZoneInfo("Asia/Shanghai")
WORK_WINDOWS = ((9 * 60 + 30, 12 * 60), (14 * 60, 18 * 60 + 30))


def now_ms() -> int:
    return int(time.time() * 1000)


def _local_timestamp(day, minutes: int) -> int:
    hour, minute = divmod(minutes, 60)
    return int(datetime(day.year, day.month, day.day, hour, minute, tzinfo=SHANGHAI).timestamp() * 1000)


def _next_workday(day):
    next_day = day + timedelta(days=1)
    while next_day.weekday() >= 5:
        next_day += timedelta(days=1)
    return next_day


def _working_milliseconds_between(start_ms: int, end_ms: int) -> int:
    start_ms = int(start_ms)
    end_ms = int(end_ms)
    if end_ms <= start_ms:
        return 0

    start = datetime.fromtimestamp(start_ms / 1000, SHANGHAI)
    end = datetime.fromtimestamp(end_ms / 1000, SHANGHAI)
    total_ms = 0
    day = start.date()
    while day <= end.date():
        if day.weekday() < 5:
            for window_start, window_end in WORK_WINDOWS:
                window_start_ms = _local_timestamp(day, window_start)
                window_end_ms = _local_timestamp(day, window_end)
                total_ms += max(0, min(end_ms, window_end_ms) - max(start_ms, window_start_ms))
        day += timedelta(days=1)
    return total_ms


def working_minutes_between(start_ms: int, end_ms: int) -> int:
    """Return elapsed minutes that overlap Shanghai weekday work windows."""
    return round(_working_milliseconds_between(start_ms, end_ms) / 60000)


def add_working_minutes(start_ms: int, minutes: int) -> int:
    """Return the timestamp after consuming weekday work-window minutes."""
    remaining_ms = max(0, int(minutes)) * 60000
    cursor_ms = int(start_ms)
    if remaining_ms == 0:
        return cursor_ms

    while True:
        local = datetime.fromtimestamp(cursor_ms / 1000, SHANGHAI)
        day = local.date()
        if day.weekday() >= 5:
            cursor_ms = _local_timestamp(_next_workday(day), WORK_WINDOWS[0][0])
            continue

        advanced = False
        for window_start, window_end in WORK_WINDOWS:
            window_start_ms = _local_timestamp(day, window_start)
            window_end_ms = _local_timestamp(day, window_end)
            if cursor_ms < window_start_ms:
                cursor_ms = window_start_ms
            if cursor_ms >= window_end_ms:
                continue
            available_ms = window_end_ms - cursor_ms
            if remaining_ms <= available_ms:
                return cursor_ms + remaining_ms
            remaining_ms -= available_ms
            cursor_ms = window_end_ms
            advanced = True
        if not advanced or cursor_ms >= _local_timestamp(day, WORK_WINDOWS[-1][1]):
            cursor_ms = _local_timestamp(_next_workday(day), WORK_WINDOWS[0][0])


def today() -> str:
    return datetime.now(SHANGHAI).strftime("%Y-%m-%d")


def date_string(offset_days: int = 0) -> str:
    return (datetime.now(SHANGHAI) + timedelta(days=offset_days)).strftime("%Y-%m-%d")


def day_start_ms(offset_days: int = 0) -> int:
    value = datetime.now(SHANGHAI) + timedelta(days=offset_days)
    return int(value.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=15, factory=ClosingConnection)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 15000")
    return db


def initialize_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH, timeout=15, factory=ClosingConnection) as db:
        table = db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").fetchone()
        if table and "'YWH'" not in str(table[0]):
            db.execute("PRAGMA foreign_keys = OFF")
            db.executescript(
                """BEGIN IMMEDIATE;
                CREATE TABLE tasks_v2 (
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
                  notes TEXT,
                  rework_count INTEGER NOT NULL DEFAULT 0,
                  is_paused INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  submitted_at INTEGER,
                  completed_at INTEGER
                );
                INSERT INTO tasks_v2 SELECT * FROM tasks;
                DROP TABLE tasks;
                ALTER TABLE tasks_v2 RENAME TO tasks;
                COMMIT;"""
            )
        db.executescript(SCHEMA.read_text(encoding="utf-8"))
        db.execute("CREATE TABLE IF NOT EXISTS employee_sessions (token_hash TEXT PRIMARY KEY, member TEXT NOT NULL, expires_at INTEGER NOT NULL)")
        columns = {row[1] for row in db.execute("PRAGMA table_info(tasks)").fetchall()}
        if "variance_reason" not in columns:
            db.execute("ALTER TABLE tasks ADD COLUMN variance_reason TEXT")
        db.execute("CREATE TABLE IF NOT EXISTS task_groups (id TEXT PRIMARY KEY, assignee TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, title TEXT NOT NULL, deliverable_expectation TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, source_text TEXT NOT NULL, warnings_json TEXT NOT NULL, stated_minutes INTEGER, created_at INTEGER NOT NULL, UNIQUE(assignee, request_id))")
        if "group_id" not in columns:
            db.execute("ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id)")
        if "group_order" not in columns:
            db.execute("ALTER TABLE tasks ADD COLUMN group_order INTEGER")
        db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id, group_order)")
        workflow.migrate(db)
        progress_columns = {row[1] for row in db.execute("PRAGMA table_info(progress_updates)").fetchall()}
        if "report_status" not in progress_columns:
            db.execute("ALTER TABLE progress_updates ADD COLUMN report_status TEXT NOT NULL DEFAULT '正常推进'")
        db.execute("PRAGMA foreign_keys = ON")
        violations = db.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError("数据库成员迁移后存在外键错误。")


def actor_for(header: str | None) -> str | None:
    if not header or not header.startswith("Bearer "):
        return None
    supplied = header[7:]
    for member in MEMBERS:
        key = f"MCP_TOKEN_{member}"
        expected = os.environ.get(key, "")
        if expected and hmac.compare_digest(supplied, expected):
            return member
    return None


def member_role(member: str) -> str:
    return "admin" if member == "YWH" else "employee"


def event(db: sqlite3.Connection, task_id: str, actor: str, event_type: str, from_status: str | None, to_status: str | None, detail: str | None, timestamp: int) -> None:
    db.execute(
        "INSERT INTO task_events (id, task_id, actor, event_type, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), task_id, actor, event_type, from_status, to_status, detail, timestamp),
    )


def task_for(db: sqlite3.Connection, task_id: str, member: str) -> sqlite3.Row | None:
    return db.execute("SELECT * FROM tasks WHERE id = ? AND assignee = ?", (task_id, member)).fetchone()


def active_for(db: sqlite3.Connection, member: str, task_id=None) -> sqlite3.Row | None:
    return db.execute(
        """SELECT t.*, ws.id AS session_id, ws.started_at AS session_started_at
        FROM tasks t JOIN work_sessions ws ON ws.task_id = t.id
        WHERE t.assignee = ? AND t.status = '进行中' AND t.is_paused = 0 AND ws.ended_at IS NULL AND (? IS NULL OR t.id = ?)
        ORDER BY ws.started_at DESC LIMIT 1""",
        (member, task_id, task_id),
    ).fetchone()


def actual_minutes(db: sqlite3.Connection, task_id: str, timestamp: int) -> int:
    rows = db.execute(
        "SELECT started_at, ended_at FROM work_sessions WHERE task_id = ?",
        (task_id,),
    ).fetchall()
    total_ms = sum(
        _working_milliseconds_between(
            int(row["started_at"]),
            min(int(row["ended_at"]), int(timestamp)) if row["ended_at"] is not None else int(timestamp),
        )
        for row in rows
    )
    return round(total_ms / 60000)


def checkin_status(db: sqlite3.Connection, member: str, timestamp: int, task_id=None) -> dict[str, object]:
    if task_id is None:
        ids = db.execute("SELECT DISTINCT t.id FROM tasks t JOIN work_sessions ws ON ws.task_id=t.id WHERE t.assignee=? AND t.status='进行中' AND t.is_paused=0 AND ws.ended_at IS NULL", (member,)).fetchall()
        statuses = [checkin_status(db, member, timestamp, row['id']) for row in ids]
        return min(statuses, key=lambda value:value['next_due_at']) if statuses else {'active':False,'due':False}
    active = active_for(db, member, task_id)
    if not active:
        return {"active": False, "due": False}
    latest = db.execute(
        """SELECT report_status, summary, next_step, blocker, progress_percent, created_at
        FROM progress_updates
        WHERE task_id = ? AND session_id = ?
        ORDER BY created_at DESC LIMIT 1""",
        (active["id"], active["session_id"]),
    ).fetchone()
    baseline = int(latest["created_at"] if latest else active["session_started_at"])
    next_due_at = add_working_minutes(baseline, CHECKIN_INTERVAL_MS // 60000)
    return {
        "active": True,
        "due": timestamp >= next_due_at,
        "task_id": active["id"],
        "task_title": active["title"],
        "session_id": active["session_id"],
        "session_started_at": active["session_started_at"],
        "last_checkin": dict(latest) if latest else None,
        "next_due_at": next_due_at,
        "remaining_minutes": max(0, working_minutes_between(timestamp, next_due_at)),
        "overdue_minutes": max(0, working_minutes_between(next_due_at, timestamp)),
    }


def promote_due_tasks(db: sqlite3.Connection, member: str | None, timestamp: int) -> None:
    parameters: list[object] = [today()]
    member_clause = ""
    if member:
        member_clause = " AND assignee = ?"
        parameters.append(member)
    due = db.execute(
        f"SELECT id, assignee FROM tasks WHERE status = '任务池' AND planned_date <= ?{member_clause}",
        parameters,
    ).fetchall()
    for task in due:
        db.execute("UPDATE tasks SET status = '今日待办', updated_at = ? WHERE id = ?", (timestamp, task["id"]))
        event(db, task["id"], task["assignee"], "进入今日待办", "任务池", "今日待办", None, timestamp)


def day_snapshot(db: sqlite3.Connection, member: str, report_date: str, timestamp: int) -> dict[str, object]:
    tasks = [dict(row) for row in db.execute(
        "SELECT * FROM tasks WHERE assignee = ? AND planned_date = ? ORDER BY created_at",
        (member, report_date),
    ).fetchall()]
    for task in tasks:
        task["actual_minutes"] = actual_minutes(db, task["id"], timestamp)
        assessed_at = task.get("submitted_at") or task.get("completed_at") or timestamp
        task.update(time_assessment(task["estimated_minutes"], task["actual_minutes"], task.get("deadline_at"), assessed_at))
    planned = round(sum(float(task["planned_points"]) for task in tasks), 1)
    completed = next(r["points"] for r in workflow.daily_scores(db, report_date, 1) if r["assignee"] == member)
    progress_updates = [dict(row) for row in db.execute(
        """SELECT p.task_id, t.title, p.summary, p.next_step, p.blocker, p.progress_percent, p.created_at
        FROM progress_updates p JOIN tasks t ON t.id = p.task_id
        WHERE p.assignee = ? AND p.created_at >= ? AND p.created_at < ?
        ORDER BY p.created_at""",
        (member, day_start_ms(), day_start_ms(1)),
    ).fetchall()]
    return {
        "member": member,
        "date": report_date,
        "planned_points": planned,
        "completed_points": completed,
        "remaining_points": round(max(0, planned - completed), 1),
        "completion_rate": round(completed / planned * 100) if planned else 0,
        "actual_minutes": sum(int(task["actual_minutes"]) for task in tasks),
        "status_counts": {status: sum(1 for task in tasks if task["status"] == status) for status in ["今日待办", "进行中", "待验收", "需修改", "已完成", "阻塞", "已关闭"]},
        "progress_updates": progress_updates,
        "tasks": tasks,
    }


def time_assessment(estimated_minutes: int, actual: int, deadline_at: int | None, assessed_at: int) -> dict[str, object]:
    variance = actual - estimated_minutes
    if estimated_minutes > 0 and variance <= -30 and actual <= estimated_minutes * 0.8:
        effort_status = "提前完成"
    elif estimated_minutes > 0 and variance >= 30 and actual >= estimated_minutes * 1.2:
        effort_status = "超出预估"
    else:
        effort_status = "符合预估"
    return {
        "estimated_minutes": estimated_minutes,
        "actual_minutes": actual,
        "variance_minutes": variance,
        "effort_status": effort_status,
        "overdue": bool(deadline_at and assessed_at > deadline_at),
    }


def tool_result(message: str, **data: object) -> dict[str, object]:
    return {"content": [{"type": "text", "text": message}], "structuredContent": {"ok": True, **data}}


TOOLS = [
    {"name": "work_get_active", "description": "查看当前员工正在计时或暂停中的任务。", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}, "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}},
    {"name": "work_create_tasks", "description": "员工确认 AI 的任务拆分后，将选中的任务登记到今日待办。", "inputSchema": {"type": "object", "properties": {"tasks": {"type": "array", "minItems": 1, "maxItems": 8, "items": {"type": "object", "required": ["title", "type", "estimated_minutes"], "properties": {"title": {"type": "string"}, "type": {"type": "string", "enum": TASK_TYPES}, "estimated_minutes": {"type": "integer", "minimum": 15, "maximum": 1440}, "deliverable_expectation": {"type": "string"}, "acceptance_criteria": {"type": "string"}, "deadline_at": {"type": "string"}, "dependency_titles": {"type": "array", "items": {"type": "string"}}, "parallel_group": {"type": "string"}}}}}, "required": ["tasks"], "additionalProperties": False}, "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}},
    {"name": "work_append_group_tasks", "description": "员工发现漏拆后，向已有大任务补充小任务，并可修正尚未提交或验收的预计分钟；不会改动已有实际计时和验收记录。", "inputSchema": {"type": "object", "properties": {"group_id": {"type": "string", "format": "uuid"}, "request_id": {"type": "string", "maxLength": 80}, "reason": {"type": "string", "minLength": 2, "maxLength": 500}, "tasks": {"type": "array", "minItems": 1, "maxItems": 8, "items": {"type": "object", "required": ["title", "type", "estimated_minutes"], "properties": {"title": {"type": "string"}, "type": {"type": "string", "enum": TASK_TYPES}, "estimated_minutes": {"type": "integer", "minimum": 15, "maximum": 1440}, "deliverable_expectation": {"type": "string"}, "acceptance_criteria": {"type": "string"}}}}, "estimate_updates": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["task_id", "estimated_minutes"], "properties": {"task_id": {"type": "string", "format": "uuid"}, "estimated_minutes": {"type": "integer", "minimum": 15, "maximum": 1440}}}}}, "required": ["group_id", "reason", "tasks"], "additionalProperties": False}, "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}},
    {"name": "work_start_task", "description": "员工确认开始后，为指定任务打开服务器计时。", "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string", "format": "uuid"}}, "required": ["task_id"], "additionalProperties": False}},
    {"name": "work_pause_task", "description": "暂停当前任务并关闭当前计时段。", "inputSchema": {"type": "object", "properties": {"reason": {"type": "string"}}, "additionalProperties": False}},
    {"name": "work_resume_task", "description": "继续一项已暂停的任务。", "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string", "format": "uuid"}}, "required": ["task_id"], "additionalProperties": False}},
    {"name": "work_block_task", "description": "记录需求、程序、素材或权限等阻塞原因。", "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string", "format": "uuid"}, "reason": {"type": "string"}}, "required": ["task_id", "reason"], "additionalProperties": False}},
    {"name": "work_finish_task", "description": "结束计时、保存完成总结、员工自评分和交付链接并提交待验收。实际耗时与预估偏差由服务器自动计算。", "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string", "format": "uuid"}, "summary": {"type": "string"}, "employee_points": {"type": "integer", "minimum": 0, "maximum": 10000, "description": "员工提交时必须填写的自评分；0 也算有效。"}, "employee_reason": {"type": "string", "maxLength": 2000, "description": "员工自评分说明，可选。"}, "deliverable_urls": {"type": "array", "items": {"type": "string", "format": "uri"}}, "variance_reason": {"type": "string", "enum": VARIANCE_REASONS, "description": "仅在明显超出预估时选填。"}}, "required": ["task_id", "summary", "employee_points"], "additionalProperties": False}},
    {"name": "work_update_submission", "description": "员工在负责人处理前修正自己的待验收完成说明、自评分和评分说明；不撤回任务，也不改变提交时间。", "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string", "format": "uuid"}, "summary": {"type": "string", "minLength": 2, "maxLength": 1200}, "employee_points": {"type": "integer", "minimum": 0, "maximum": 10000}, "employee_reason": {"type": "string", "maxLength": 2000}}, "required": ["task_id", "summary", "employee_points"], "additionalProperties": False}},
    {"name": "work_get_day_summary", "description": "读取员工今日任务、计时、完成情况和已安排的明日任务，供 AI 起草今日总结与明日计划。", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}, "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}},
    {"name": "work_submit_daily_report", "description": "员工一次确认后保存今日总结，并把确认的明日任务放入明日任务池。", "inputSchema": {"type": "object", "properties": {"summary": {"type": "string", "minLength": 2, "maxLength": 2000}, "tomorrow_tasks": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["title", "type", "estimated_minutes"], "properties": {"title": {"type": "string"}, "type": {"type": "string", "enum": TASK_TYPES}, "estimated_minutes": {"type": "integer", "minimum": 15, "maximum": 1440}, "deliverable_expectation": {"type": "string"}, "acceptance_criteria": {"type": "string"}, "deadline_at": {"type": "string"}, "dependency_titles": {"type": "array", "items": {"type": "string"}}, "parallel_group": {"type": "string"}}}}}, "required": ["summary", "tomorrow_tasks"], "additionalProperties": False}},
    {"name": "work_report_heartbeat", "description": "记录员工明确提交的 30 分钟 hb 进展，服务器返回累计工时和下一次汇报节点。", "inputSchema": {"type": "object", "properties": {"status": {"type": "string", "enum": HEARTBEAT_STATUSES}, "detail": {"type": "string", "maxLength": 500}, "next_step": {"type": "string", "maxLength": 500}, "blocker": {"type": "string", "maxLength": 500}, "progress_percent": {"type": "integer", "minimum": 0, "maximum": 100}}, "required": ["status"], "additionalProperties": False}},
    {"name": "work_checkin_progress", "description": "兼容旧版进展汇报；新版 hb 应使用 work_report_heartbeat。", "inputSchema": {"type": "object", "properties": {"summary": {"type": "string", "minLength": 2, "maxLength": 500}, "next_step": {"type": "string", "maxLength": 500}, "blocker": {"type": "string", "maxLength": 500}, "progress_percent": {"type": "integer", "minimum": 0, "maximum": 100}}, "required": ["summary"], "additionalProperties": False}},
]

for definition in TOOLS:
    if definition['name'] in ('work_pause_task', 'work_report_heartbeat', 'work_checkin_progress'):
        definition['inputSchema']['properties']['task_id'] = {'type':'string', 'format':'uuid'}
for name, description in [('work_set_high_priority','将自己的负责人临时插单手动设为唯一高优先，旧高优先恢复正常。'),('work_unblock_task','解除自己的阻塞任务，恢复待办。'),('work_withdraw_submission','员工撤回自己尚未被处理的待验收提交，保留计时历史并恢复为暂停中的工作。')]:
    TOOLS.append({'name':name,'description':description,'inputSchema':{'type':'object','properties':{'task_id':{'type':'string','format':'uuid'}},'required':['task_id'],'additionalProperties':False}})


def call_tool(member: str, name: str, args: dict[str, object]) -> dict[str, object]:
    if name == "work_append_group_tasks":
        result = append_task_group(member, args)
        message = result.pop("message")
        return tool_result(message, **result)
    timestamp = now_ms()
    with DB_LOCK, connect() as db:
        promote_due_tasks(db, member, timestamp)
        if name in ('owner_insert_task', 'owner_review_task', 'owner_review_group', 'owner_close_task', 'owner_set_task_score', 'work_set_high_priority', 'work_unblock_task', 'work_withdraw_submission'):
            attachments = task_files.decode_files(args.get("attachments", [])) if name == "owner_review_task" else []
            result = workflow.apply(db, member, name, args, timestamp, event, today())
            if attachments:
                db.executemany(
                    "INSERT INTO task_attachments (id, task_id, name, content_type, body) VALUES (?, ?, ?, ?, ?)",
                    [(file_id, str(args.get("task_id", "")), name, mime, body) for file_id, name, mime, body in attachments],
                )
            return tool_result(result.pop('message'), **result)
        if name == "work_get_active":
            active_tasks = [dict(r) for r in db.execute("SELECT * FROM tasks WHERE assignee=? AND status='进行中' ORDER BY updated_at DESC", (member,))]
            task = active_tasks[0] if active_tasks else None
            if not task:
                return tool_result("当前没有进行中的任务。", task=None, tasks=[])
            for active_task in active_tasks:
                minutes = actual_minutes(db, active_task["id"], timestamp)
                active_task.update(time_assessment(active_task["estimated_minutes"], minutes, active_task["deadline_at"], timestamp))
                active_task["checkin"] = checkin_status(db, member, timestamp, active_task["id"])
            value = active_tasks[0]
            return tool_result(f"当前任务：{task['title']}{'（已暂停）' if task['is_paused'] else '（计时中）'}", task=value, tasks=active_tasks)

        if name in ("work_report_heartbeat", "work_checkin_progress"):
            if not args.get('task_id') and db.execute("SELECT COUNT(*) FROM work_sessions WHERE assignee=? AND ended_at IS NULL", (member,)).fetchone()[0] > 1:
                raise ValueError('有多个并行任务，请指定 task_id。')
            active = active_for(db, member, args.get('task_id'))
            if not active:
                raise ValueError("当前没有正在计时的任务，暂停状态不会要求进展汇报。")
            report_status = str(args.get("status") or "正常推进")
            if report_status not in HEARTBEAT_STATUSES:
                raise ValueError("hb 汇报状态不正确。")
            detail = str(args.get("detail") or args.get("summary") or "").strip()[:500]
            next_step = str(args.get("next_step", "")).strip()[:500] or None
            blocker = str(args.get("blocker", "")).strip()[:500] or None
            raw_percent = args.get("progress_percent")
            progress_percent = int(raw_percent) if raw_percent is not None else None
            if report_status == "已完成阶段" and len(detail) < 2:
                raise ValueError("请简短说明完成了哪一部分。")
            if report_status == "遇到问题" and not (blocker or detail):
                raise ValueError("请简短说明遇到的问题。")
            if progress_percent is not None and not 0 <= progress_percent <= 100:
                raise ValueError("进展内容或完成比例不正确。")
            summary = detail or report_status
            images = report_images.decode_images(args.get("images", []))
            archives = report_files.decode_archives(args.get("attachments", []))
            progress_id = str(uuid.uuid4())
            db.execute(
                """INSERT INTO progress_updates (id, task_id, session_id, assignee, report_status, summary, next_step, blocker, progress_percent, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (progress_id, active["id"], active["session_id"], member, report_status, summary, next_step, blocker, progress_percent, timestamp),
            )
            db.executemany("INSERT INTO progress_images (id, progress_id, name, content_type, body) VALUES (?, ?, ?, ?, ?)",
                           [(image_id, progress_id, name, mime, body) for image_id, name, mime, body in images])
            db.executemany("INSERT INTO progress_attachments (id, progress_id, name, content_type, body) VALUES (?, ?, ?, ?, ?)",
                           [(file_id, progress_id, name, mime, body) for file_id, name, mime, body in archives])
            event(db, active["id"], member, "30分钟汇报", "进行中", "进行中", f"{report_status}：{summary}", timestamp)
            minutes = actual_minutes(db, active["id"], timestamp)
            if report_status == "已完成阶段":
                readable = summary if summary.startswith("已完成") else f"已完成{summary}"
            else:
                readable = f"{report_status}{'：' + summary if summary != report_status else ''}"
            server_reply = f"服务器已收到：{readable}。当前累计计时 {minutes} 分钟；下次汇报节点为 30 分钟后。"
            return tool_result(
                server_reply,
                task_id=active["id"],
                status=report_status,
                summary=summary,
                next_step=next_step,
                blocker=blocker,
                progress_percent=progress_percent,
                actual_minutes=minutes,
                server_reply=server_reply,
                created_at=timestamp,
                next_due_at=timestamp + CHECKIN_INTERVAL_MS,
            )

        if name == "work_create_tasks":
            items = args.get("tasks")
            if not isinstance(items, list) or not 1 <= len(items) <= 8:
                raise ValueError("任务数量必须为 1 到 8 项。")
            created = []
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("任务格式不正确。")
                title = str(item.get("title", "")).strip()[:120]
                kind = str(item.get("type", "其他"))
                minutes = int(item.get("estimated_minutes", 0))
                if not title or kind not in TASK_TYPES or not 15 <= minutes <= 1440:
                    raise ValueError("任务名称、类型或预计时间不正确。")
                task_id = str(uuid.uuid4())
                points = round(minutes / 60 * 2) / 2
                deadline = item.get("deadline_at")
                deadline_ms = int(datetime.fromisoformat(str(deadline).replace("Z", "+00:00")).timestamp() * 1000) if deadline else None
                notes = json.dumps({"dependency_titles": item.get("dependency_titles", []), "parallel_group": item.get("parallel_group")}, ensure_ascii=False)
                db.execute(
                    """INSERT INTO tasks (id, assignee, title, type, status, priority, planned_date, deadline_at, estimated_minutes, planned_points, deliverable_expectation, acceptance_criteria, notes, created_at, updated_at)
                    VALUES (?, ?, ?, ?, '今日待办', '普通', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (task_id, member, title, kind, today(), deadline_ms, minutes, points, item.get("deliverable_expectation"), item.get("acceptance_criteria"), notes, timestamp, timestamp),
                )
                event(db, task_id, member, "创建任务", None, "今日待办", None, timestamp)
                created.append({"id": task_id, "title": title, "planned_points": points, "status": "今日待办"})
            return tool_result(f"已登记 {len(created)} 项任务，尚未开始计时。", tasks=created)

        if name == "work_get_day_summary":
            snapshot = day_snapshot(db, member, today(), timestamp)
            tomorrow_tasks = [dict(row) for row in db.execute(
                "SELECT id, title, type, status, estimated_minutes, planned_points, deliverable_expectation, acceptance_criteria, notes FROM tasks WHERE assignee = ? AND planned_date = ? ORDER BY created_at",
                (member, date_string(1)),
            ).fetchall()]
            report = db.execute("SELECT summary, submitted_at FROM daily_reports WHERE assignee = ? AND report_date = ?", (member, today())).fetchone()
            return tool_result(
                f"已读取 {member} 今日记录：计划 {snapshot['planned_points']} 点，完成 {snapshot['completed_points']} 点。",
                snapshot=snapshot,
                tomorrow_date=date_string(1),
                tomorrow_tasks=tomorrow_tasks,
                report=dict(report) if report else None,
            )

        if name == "work_submit_daily_report":
            if db.execute("SELECT 1 FROM daily_reports WHERE assignee = ? AND report_date = ?", (member, today())).fetchone():
                raise ValueError("今日日报已经提交，避免重复创建明日任务。")
            summary = str(args.get("summary", "")).strip()[:2000]
            items = args.get("tomorrow_tasks")
            if len(summary) < 2 or not isinstance(items, list) or len(items) > 8:
                raise ValueError("今日总结或明日任务格式不正确。")
            snapshot = day_snapshot(db, member, today(), timestamp)
            created = []
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("明日任务格式不正确。")
                title = str(item.get("title", "")).strip()[:120]
                kind = str(item.get("type", "其他"))
                minutes = int(item.get("estimated_minutes", 0))
                if not title or kind not in TASK_TYPES or not 15 <= minutes <= 1440:
                    raise ValueError("明日任务名称、类型或预计时间不正确。")
                task_id = str(uuid.uuid4())
                points = round(minutes / 60 * 2) / 2
                deadline = item.get("deadline_at")
                deadline_ms = int(datetime.fromisoformat(str(deadline).replace("Z", "+00:00")).timestamp() * 1000) if deadline else None
                notes = json.dumps({"dependency_titles": item.get("dependency_titles", []), "parallel_group": item.get("parallel_group"), "source_report_date": today()}, ensure_ascii=False)
                db.execute(
                    """INSERT INTO tasks (id, assignee, title, type, status, priority, planned_date, deadline_at, estimated_minutes, planned_points, deliverable_expectation, acceptance_criteria, notes, created_at, updated_at)
                    VALUES (?, ?, ?, ?, '任务池', '普通', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (task_id, member, title, kind, date_string(1), deadline_ms, minutes, points, item.get("deliverable_expectation"), item.get("acceptance_criteria"), notes, timestamp, timestamp),
                )
                event(db, task_id, member, "日报安排明日任务", None, "任务池", None, timestamp)
                created.append({"id": task_id, "title": title, "planned_points": points, "status": "任务池"})
            db.execute(
                "INSERT INTO daily_reports (id, assignee, report_date, summary, snapshot_json, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), member, today(), summary, json.dumps(snapshot, ensure_ascii=False), timestamp, timestamp),
            )
            return tool_result(f"今日日报已提交，已安排 {len(created)} 项明日任务。", report_date=today(), tomorrow_date=date_string(1), tasks=created)

        task_id = str(args.get("task_id", ""))
        if name == "work_start_task":
            task = task_for(db, task_id, member)
            if not task:
                raise ValueError("找不到该员工的任务。")
            if task["status"] not in ("今日待办", "需修改"):
                raise ValueError(f"任务状态 {task['status']} 不能开始。")
            db.execute("UPDATE tasks SET status = '进行中', is_paused = 0, updated_at = ? WHERE id = ?", (timestamp, task_id))
            db.execute("INSERT INTO work_sessions (id, task_id, assignee, started_at) VALUES (?, ?, ?, ?)", (str(uuid.uuid4()), task_id, member, timestamp))
            event(db, task_id, member, "开始计时", task["status"], "进行中", None, timestamp)
            return tool_result(f"已开始：{task['title']}", task_id=task_id, status="进行中", started_at=timestamp)

        if name == "work_pause_task":
            if not args.get('task_id') and db.execute("SELECT COUNT(*) FROM work_sessions WHERE assignee=? AND ended_at IS NULL", (member,)).fetchone()[0] > 1:
                raise ValueError('有多个并行任务，请指定 task_id。')
            active = active_for(db, member, args.get('task_id'))
            if not active:
                raise ValueError("当前没有正在计时的任务。")
            db.execute("UPDATE work_sessions SET ended_at = ?, end_reason = '暂停' WHERE id = ?", (timestamp, active["session_id"]))
            db.execute("UPDATE tasks SET is_paused = 1, updated_at = ? WHERE id = ?", (timestamp, active["id"]))
            event(db, active["id"], member, "暂停计时", "进行中", "进行中", str(args.get("reason") or "") or None, timestamp)
            return tool_result(f"已暂停：{active['title']}", task_id=active["id"], status="进行中", paused=True)

        task = task_for(db, task_id, member)
        if not task:
            raise ValueError("找不到该员工的任务。")
        if name == "work_update_submission":
            if task["status"] != "待验收":
                raise ValueError("只有负责人尚未处理的待验收任务可以修改。")
            summary = str(args.get("summary", "")).strip()
            if not 2 <= len(summary) <= 1200:
                raise ValueError("请填写 2–1200 字完成说明。")
            employee_score = workflow.points(args.get("employee_points"))
            employee_reason = str(args.get("employee_reason") or "").strip()
            if len(employee_reason) > 2000:
                raise ValueError("评分说明不能超过 2000 字。")
            changed = db.execute(
                """UPDATE tasks
                   SET result_summary=?, employee_ai_points=?, employee_ai_reason=?,
                       platform_ai_points=NULL, platform_ai_reason=NULL, updated_at=?
                   WHERE id=? AND assignee=? AND status='待验收'""",
                (summary, employee_score, employee_reason or None, timestamp, task_id, member),
            ).rowcount
            if not changed:
                raise ValueError("任务已被处理，请刷新后重试。")
            event(
                db,
                task_id,
                member,
                "修改待验收内容",
                "待验收",
                "待验收",
                json.dumps(
                    {
                        "previous_summary": task["result_summary"],
                        "summary": summary,
                        "previous_points": task["employee_ai_points"],
                        "points": employee_score,
                        "previous_reason": task["employee_ai_reason"],
                        "reason": employee_reason or None,
                    },
                    ensure_ascii=False,
                ),
                timestamp,
            )
            return tool_result(
                f"已更新待验收内容：{task['title']}，申请 {employee_score} 点。",
                task_id=task_id,
                status="待验收",
                employee_points=employee_score,
            )
        if name == "work_resume_task":
            if task["status"] != "进行中" or not task["is_paused"]:
                raise ValueError("该任务不是可继续的暂停任务。")
            db.execute("UPDATE tasks SET is_paused = 0, updated_at = ? WHERE id = ?", (timestamp, task_id))
            db.execute("INSERT INTO work_sessions (id, task_id, assignee, started_at) VALUES (?, ?, ?, ?)", (str(uuid.uuid4()), task_id, member, timestamp))
            event(db, task_id, member, "继续计时", "进行中", "进行中", None, timestamp)
            return tool_result(f"已继续：{task['title']}", task_id=task_id, status="进行中", resumed_at=timestamp)

        if name == "work_block_task":
            if task["status"] not in ("今日待办", "进行中", "需修改"):
                raise ValueError("当前状态不能标记阻塞。")
            reason = str(args.get("reason", "")).strip()[:500]
            if len(reason) < 2:
                raise ValueError("请填写阻塞原因。")
            attachments = task_files.decode_files(args.get("attachments", []))
            open_session = db.execute("SELECT id FROM work_sessions WHERE task_id = ? AND ended_at IS NULL LIMIT 1", (task_id,)).fetchone()
            if open_session:
                db.execute("UPDATE work_sessions SET ended_at = ?, end_reason = '阻塞' WHERE id = ?", (timestamp, open_session["id"]))
            db.execute("UPDATE tasks SET status = '阻塞', is_paused = 0, blocked_reason = ?, updated_at = ? WHERE id = ?", (reason, timestamp, task_id))
            event(db, task_id, member, "任务阻塞", task["status"], "阻塞", reason, timestamp)
            db.executemany(
                "INSERT INTO task_attachments (id, task_id, name, content_type, body) VALUES (?, ?, ?, ?, ?)",
                [(file_id, task_id, name, mime, body) for file_id, name, mime, body in attachments],
            )
            return tool_result(f"已标记阻塞：{task['title']}", task_id=task_id, status="阻塞", reason=reason)

        if name == "work_finish_task":
            if task["status"] != "进行中":
                raise ValueError("该任务不在进行中。")
            summary = str(args.get("summary", "")).strip()[:1200]
            if len(summary) < 2:
                raise ValueError("请填写完成总结。")
            attachments = task_files.decode_files(args.get("attachments", []))
            if 'employee_points' in args:
                employee_score = args.get('employee_points')
                employee_reason = str(args.get('employee_reason') or '').strip()
            elif 'employee_ai_points' in args:
                # Accept the old internal name for existing MCP callers while
                # exposing the employee-facing self-score contract above.
                employee_score = args.get('employee_ai_points')
                employee_reason = str(args.get('employee_ai_reason') or '').strip()
            else:
                raise ValueError('提交任务时必须填写员工自评分，0 也算有效。')
            employee_score = workflow.points(employee_score)
            if len(employee_reason) > 2000:
                raise ValueError('员工自评分说明不能超过 2000 字。')
            db.execute('UPDATE tasks SET employee_ai_points=?,employee_ai_reason=?,platform_ai_points=NULL,platform_ai_reason=NULL WHERE id=?', (employee_score, employee_reason or None, task_id))
            urls = args.get("deliverable_urls") or []
            if not isinstance(urls, list) or len(urls) > 12:
                raise ValueError("交付链接格式不正确。")
            variance_reason = str(args.get("variance_reason", "")).strip() or None
            if variance_reason and variance_reason not in VARIANCE_REASONS:
                raise ValueError("超出预估原因不在可选范围内。")
            open_session = db.execute("SELECT id FROM work_sessions WHERE task_id = ? AND ended_at IS NULL LIMIT 1", (task_id,)).fetchone()
            if open_session:
                db.execute("UPDATE work_sessions SET ended_at = ?, end_reason = '提交' WHERE id = ?", (timestamp, open_session["id"]))
            for index, url in enumerate(urls):
                parsed = urlparse(str(url))
                if parsed.scheme not in ("http", "https") or not parsed.netloc:
                    raise ValueError("交付链接必须是 HTTP 或 HTTPS 地址。")
                db.execute("INSERT INTO deliverables (id, task_id, kind, label, url, created_at) VALUES (?, ?, '链接', ?, ?, ?)", (str(uuid.uuid4()), task_id, f"交付物 {index + 1}", str(url), timestamp))
            minutes = actual_minutes(db, task_id, timestamp)
            assessment = time_assessment(task["estimated_minutes"], minutes, task["deadline_at"], timestamp)
            if assessment["effort_status"] != "超出预估":
                variance_reason = None
            db.execute("UPDATE tasks SET status = '待验收', is_paused = 0, result_summary = ?, variance_reason = ?, submitted_at = ?, first_submitted_points = CASE WHEN first_submitted_at IS NULL THEN ? ELSE first_submitted_points END, first_submitted_at = COALESCE(first_submitted_at, ?), updated_at = ? WHERE id = ?", (summary, variance_reason, timestamp, employee_score, timestamp, timestamp, task_id))
            event(db, task_id, member, "提交验收", "进行中", "待验收", summary, timestamp)
            db.executemany(
                "INSERT INTO task_attachments (id, task_id, name, content_type, body) VALUES (?, ?, ?, ?, ?)",
                [(file_id, task_id, name, mime, body) for file_id, name, mime, body in attachments],
            )
            return tool_result(f"已提交待验收：{task['title']}，实际记录 {minutes} 分钟，{assessment['effort_status']}。", task_id=task_id, status="待验收", submitted_at=timestamp, variance_reason=variance_reason, summary=summary, deliverables=urls, **assessment)

        raise ValueError("未知工具。")


def create_task_group(member, data):
    plan = validate_plan(data.get("plan"), confirmed=True)
    source = plan_text(data.get("source_text"), "原始描述", 8000, optional=True)
    request_id = plan_text(data.get("request_id"), "登记编号", 80)
    fingerprint = hashlib.sha256(json.dumps({"plan": plan, "source": source}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    with DB_LOCK, connect() as db:
        db.execute("BEGIN IMMEDIATE")
        previous = db.execute("SELECT id, payload_hash FROM task_groups WHERE assignee = ? AND request_id = ?", (member, request_id)).fetchone()
        if previous:
            if previous["payload_hash"] != fingerprint:
                raise ValueError("该登记已确认，请刷新任务列表后再登记新的工作。")
            return {"ok": True, "group_id": previous["id"], "message": "该任务已登记，未重复创建。"}
        group_id = str(uuid.uuid4())
        stamp = now_ms()
        group = plan["group"]
        db.execute("INSERT INTO task_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (group_id, member, request_id, fingerprint, group["title"], group["deliverable_expectation"], group["acceptance_criteria"], source, json.dumps(plan["warnings"], ensure_ascii=False), plan["stated_minutes"], stamp))
        for order, task in enumerate(plan["tasks"]):
            task_id = str(uuid.uuid4())
            minutes = task["estimated_minutes"]
            db.execute("""INSERT INTO tasks (id, assignee, title, type, status, planned_date, estimated_minutes, planned_points, deliverable_expectation, acceptance_criteria, created_at, updated_at, group_id, group_order)
                VALUES (?, ?, ?, ?, '今日待办', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (task_id, member, task["title"], task["type"], today(), minutes, round(minutes / 60 * 2) / 2, task["deliverable_expectation"], task["acceptance_criteria"], stamp, stamp, group_id, order))
            event(db, task_id, member, "创建任务", None, "今日待办", "大任务：" + group["title"], stamp)
    return {"ok": True, "group_id": group_id, "message": f"已登记 1 个大任务和 {len(plan['tasks'])} 个小任务，尚未开始计时。"}


def append_task_group(member, data):
    """Append confirmed child tasks to an existing group without touching history."""
    group_id = plan_text(data.get("group_id"), "大任务编号", 80)
    reason = plan_text(data.get("reason"), "补充原因", 500)
    raw_request_id = data.get("request_id")
    request_id = plan_text(raw_request_id if raw_request_id is not None else "", "补充编号", 80, optional=True)
    raw_tasks = data.get("tasks")
    if not isinstance(raw_tasks, list) or not 1 <= len(raw_tasks) <= 8:
        raise ValueError("补充的小任务必须为 1 到 8 项。")
    raw_updates = data.get("estimate_updates", [])
    if raw_updates is None:
        raw_updates = []
    if not isinstance(raw_updates, list) or len(raw_updates) > 8:
        raise ValueError("预计时间调整格式不正确。")

    # Reuse the same strict field and time validation as the initial planner.
    # A group is capped at eight children, so adding items cannot silently
    # create a plan that the normal planner could not represent.
    clean = validate_plan(
        {
            "group": {
                "title": "补充小任务",
                "deliverable_expectation": "补充的小任务交付",
                "acceptance_criteria": "按补充的小任务验收",
            },
            "stated_minutes": sum(
                task.get("estimated_minutes", 0)
                for task in raw_tasks
                if isinstance(task, dict) and type(task.get("estimated_minutes")) is int
            ),
            "tasks": raw_tasks,
            "warnings": [],
        },
        confirmed=True,
    )

    with DB_LOCK, connect() as db:
        db.execute("BEGIN IMMEDIATE")
        group = db.execute(
            "SELECT * FROM task_groups WHERE id = ? AND assignee = ?",
            (group_id, member),
        ).fetchone()
        if not group:
            raise ValueError("找不到属于当前成员的大任务。")
        children = db.execute(
            "SELECT id, title, status, estimated_minutes, group_order FROM tasks WHERE group_id = ? ORDER BY group_order, created_at",
            (group_id,),
        ).fetchall()
        payload_hash = hashlib.sha256(
            json.dumps(
                {"reason": reason, "tasks": clean["tasks"], "estimate_updates": raw_updates},
                ensure_ascii=False,
                sort_keys=True,
            ).encode()
        ).hexdigest()
        if request_id:
            existing_rows = []
            for row in db.execute("SELECT estimated_minutes, notes FROM tasks WHERE group_id = ?", (group_id,)).fetchall():
                try:
                    notes = json.loads(row["notes"] or "{}")
                except (TypeError, json.JSONDecodeError):
                    notes = {}
                if notes.get("append_request_id") == request_id:
                    existing_rows.append(row)
            if existing_rows:
                try:
                    existing_notes = json.loads(existing_rows[0]["notes"] or "{}")
                except (TypeError, json.JSONDecodeError):
                    existing_notes = {}
                if existing_notes.get("append_payload_hash") != payload_hash:
                    raise ValueError("该补充编号已使用，请刷新任务列表后重新提交。")
                existing_count = len(existing_rows)
                existing_total = sum(int(row["estimated_minutes"]) for row in existing_rows)
                return {
                    "ok": True,
                    "group_id": group_id,
                    "added_count": existing_count,
                    "added_minutes": existing_total,
                    "updated_count": 0,
                    "updated_minutes_delta": 0,
                    "estimated_minutes": sum(int(child["estimated_minutes"]) for child in children),
                    "stated_minutes": group["stated_minutes"],
                    "message": "该补充已登记，未重复创建。",
                }

        if len(children) + len(clean["tasks"]) > 8:
            raise ValueError(f"一个大任务最多保留 8 个小任务，当前已有 {len(children)} 项。")

        before_minutes = sum(int(child["estimated_minutes"]) for child in children)
        child_by_id = {child["id"]: child for child in children}
        updates = []
        update_ids = set()
        for raw_update in raw_updates:
            if not isinstance(raw_update, dict):
                raise ValueError("预计时间调整格式不正确。")
            update_id = plan_text(raw_update.get("task_id"), "待调整小任务编号", 80)
            if update_id in update_ids:
                raise ValueError("同一小任务不能重复调整预计时间。")
            update_ids.add(update_id)
            child = child_by_id.get(update_id)
            if not child:
                raise ValueError("待调整的小任务不属于当前大任务。")
            if child["status"] in ("已完成", "待验收"):
                raise ValueError(f"“{child['title']}”已经提交或验收，不能再调整预计时间。")
            new_minutes = raw_update.get("estimated_minutes")
            if type(new_minutes) is not int or not 15 <= new_minutes <= 1440:
                raise ValueError("每个调整后的预计分钟须为 15–1440 的整数。")
            updates.append((child, new_minutes))

        adjusted_before_append = before_minutes + sum(new_minutes - int(child["estimated_minutes"]) for child, new_minutes in updates)
        stamp = now_ms()
        for child, new_minutes in updates:
            old_minutes = int(child["estimated_minutes"])
            db.execute(
                "UPDATE tasks SET estimated_minutes = ?, planned_points = ?, updated_at = ? WHERE id = ? AND group_id = ?",
                (new_minutes, round(new_minutes / 60 * 2) / 2, stamp, child["id"], group_id),
            )
            event(
                db,
                child["id"],
                member,
                "调整预计时间",
                child["status"],
                child["status"],
                f"大任务：{group['title']}；原因：{reason}；预计 {old_minutes} → {new_minutes} 分钟；小任务合计 {before_minutes} → {adjusted_before_append} 分钟",
                stamp,
            )
        added_minutes = sum(int(task["estimated_minutes"]) for task in clean["tasks"])
        after_minutes = adjusted_before_append + added_minutes
        start_order = max((int(child["group_order"]) for child in children if child["group_order"] is not None), default=-1) + 1
        for offset, task in enumerate(clean["tasks"]):
            task_id = str(uuid.uuid4())
            notes = json.dumps(
                {
                    "append_reason": reason,
                    "append_to_group": group["title"],
                    "append_request_id": request_id or None,
                    "append_payload_hash": payload_hash if request_id else None,
                },
                ensure_ascii=False,
            )
            minutes = task["estimated_minutes"]
            db.execute(
                """INSERT INTO tasks (id, assignee, title, type, status, planned_date,
                    estimated_minutes, planned_points, deliverable_expectation,
                    acceptance_criteria, notes, created_at, updated_at, group_id, group_order)
                    VALUES (?, ?, ?, ?, '今日待办', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    task_id,
                    member,
                    task["title"],
                    task["type"],
                    today(),
                    minutes,
                    round(minutes / 60 * 2) / 2,
                    task["deliverable_expectation"],
                    task["acceptance_criteria"],
                    notes,
                    stamp,
                    stamp,
                    group_id,
                    start_order + offset,
                ),
            )
            event(
                db,
                task_id,
                member,
                "补充小任务",
                None,
                "今日待办",
                f"大任务：{group['title']}；原因：{reason}；补充前小任务合计 {adjusted_before_append} 分钟，补充后 {after_minutes} 分钟",
                stamp,
            )
        # Keep the parent estimate as the rough reference supplied when the
        # group was created. Child estimates are the actionable breakdown and
        # may be amended or appended independently.
    return {
        "ok": True,
        "group_id": group_id,
        "added_count": len(clean["tasks"]),
        "added_minutes": added_minutes,
        "updated_count": len(updates),
        "updated_minutes_delta": adjusted_before_append - before_minutes,
        "estimated_minutes": after_minutes,
        "stated_minutes": group["stated_minutes"],
        "message": f"已向“{group['title']}”补充 {len(clean['tasks'])} 个小任务，共 {added_minutes} 分钟；原有计时和验收记录已保留。",
    }


def task_groups(db, member=None):
    rows = db.execute("SELECT id, assignee, title, deliverable_expectation, acceptance_criteria, stated_minutes, created_at FROM task_groups" + (" WHERE assignee = ?" if member else "") + " ORDER BY created_at DESC", (member,) if member else ()).fetchall()
    result = []
    for row in rows:
        group = dict(row)
        children = [dict(t) for t in db.execute("SELECT * FROM tasks WHERE group_id = ? ORDER BY group_order", (row["id"],))]
        task_files.attach_metadata(db, children)
        timestamp = now_ms()
        for child in children:
            child["actual_minutes"] = actual_minutes(db, child["id"], timestamp)
        states = [t["status"] for t in children]
        # The owner only reviews a big task once every child is submitted, then
        # accepts the whole group in one step using the employees' own scores.
        group.update(tasks=children, estimated_minutes=sum(t["estimated_minutes"] for t in children),
                     child_estimated_minutes=sum(t["estimated_minutes"] for t in children),
                     actual_minutes=sum(t["actual_minutes"] for t in children),
                     completed_count=states.count("已完成"), total_count=len(children),
                     pending_count=states.count("待验收"),
                     suggested_points=sum(t["employee_ai_points"] for t in children if t["employee_ai_points"] is not None),
                     awarded_points=sum(t["awarded_points"] for t in children if t["awarded_points"] is not None),
                     suggested_complete=bool(children) and all(t["employee_ai_points"] is not None for t in children),
                     ready_for_acceptance=bool(children) and all(x == "待验收" for x in states),
                     status=("已关闭" if states and all(x in ("已关闭", "已完成") for x in states) and "已关闭" in states else
                             "已完成" if states and all(x == "已完成" for x in states) else
                             "待验收" if states and all(x in ("已完成", "待验收") for x in states) else
                             next((x for x in ("需修改", "阻塞", "进行中") if x in states), "进行中" if any(x in ("待验收", "已完成") for x in states) else "今日待办")))
        result.append(group)
    return result


def enrich_dashboard_tasks(db, tasks, timestamp):
    for task in tasks:
        task["actual_minutes"] = actual_minutes(db, task["id"], timestamp)
        assessed_at = task.get("submitted_at") or task.get("completed_at") or timestamp
        task.update(time_assessment(task["estimated_minutes"], int(task["actual_minutes"]), task.get("deadline_at"), assessed_at))
        if task["status"] == "进行中" and not task["is_paused"]:
            task["checkin"] = checkin_status(db, task["assignee"], timestamp, task["id"])
    if tasks:
        task_ids = [task["id"] for task in tasks]
        placeholders = ",".join("?" for _ in task_ids)
        task_sessions = {}
        for row in db.execute(
            f"SELECT * FROM work_sessions WHERE task_id IN ({placeholders}) ORDER BY started_at DESC",
            task_ids,
        ).fetchall():
            session = dict(row)
            end_ms = min(int(session["ended_at"]), timestamp) if session["ended_at"] is not None else timestamp
            session["recorded_minutes"] = working_minutes_between(int(session["started_at"]), end_ms)
            task_sessions.setdefault(session["task_id"], []).append(session)
        for task in tasks:
            task["time_sessions"] = task_sessions.get(task["id"], [])
    task_files.attach_metadata(db, tasks)
    if tasks:
        task_ids = [task["id"] for task in tasks]
        placeholders = ",".join("?" for _ in task_ids)
        by_task = {task["id"]: task for task in tasks}
        for task in tasks:
            task["deliverables"] = []
        for row in db.execute(
            f"SELECT id, task_id, kind, label, url, created_at FROM deliverables WHERE task_id IN ({placeholders}) ORDER BY created_at",
            task_ids,
        ).fetchall():
            by_task[row["task_id"]]["deliverables"].append(dict(row))
    closed_ids = [task["id"] for task in tasks if task["status"] == "已关闭"]
    if closed_ids:
        placeholders = ",".join("?" for _ in closed_ids)
        for row in db.execute(
            f"SELECT task_id, actor, detail, created_at FROM task_events WHERE task_id IN ({placeholders}) AND event_type='管理员关闭任务' ORDER BY created_at DESC",
            closed_ids,
        ).fetchall():
            task = next(item for item in tasks if item["id"] == row["task_id"] and "closed_at" not in item)
            task["closed_at"] = row["created_at"]
            task["closed_by"] = row["actor"]
            task["close_reason"] = row["detail"]


def dashboard_data() -> dict[str, object]:
    with DB_LOCK, connect() as db:
        timestamp = now_ms()
        promote_due_tasks(db, None, timestamp)
        tasks = [dict(row) for row in db.execute(
            """SELECT * FROM tasks
            WHERE planned_date = ? OR status != '已完成' OR (completed_at >= ? AND completed_at < ?)
            ORDER BY updated_at DESC""",
            (today(), day_start_ms(-6), day_start_ms(1)),
        ).fetchall()]
        all_tasks = [dict(row) for row in db.execute("SELECT * FROM tasks ORDER BY updated_at DESC").fetchall()]
        enrich_dashboard_tasks(db, tasks, timestamp)
        enrich_dashboard_tasks(db, all_tasks, timestamp)
        sessions = [dict(row) for row in db.execute("SELECT ws.*, t.title, t.type FROM work_sessions ws JOIN tasks t ON t.id = ws.task_id WHERE ws.started_at < ? AND (ws.ended_at IS NULL OR ws.ended_at > ?) ORDER BY ws.started_at DESC LIMIT 24", (day_start_ms(1), day_start_ms())).fetchall()]
        for session in sessions:
            end_ms = min(int(session["ended_at"]), timestamp) if session["ended_at"] is not None else timestamp
            session["recorded_minutes"] = working_minutes_between(int(session["started_at"]), end_ms)
        progress_updates = [dict(row) for row in db.execute(
            """SELECT p.*, t.title, t.type FROM progress_updates p
            JOIN tasks t ON t.id = p.task_id
            WHERE p.created_at >= ? AND p.created_at < ?
            ORDER BY p.created_at DESC LIMIT 60""",
            (day_start_ms(), day_start_ms(1)),
        ).fetchall()]
        timeline_start = day_start_ms(-6)
        timeline_events = [dict(row) for row in db.execute(
            """SELECT e.id, e.task_id, e.actor, e.event_type, e.from_status,
                      e.to_status, e.detail, e.created_at, t.title, t.assignee, t.type
               FROM task_events e JOIN tasks t ON t.id = e.task_id
               WHERE e.created_at >= ? AND e.created_at < ?
               ORDER BY e.created_at DESC LIMIT 500""",
            (timeline_start, day_start_ms(1)),
        ).fetchall()]
        timeline_sessions = [dict(row) for row in db.execute(
            """SELECT ws.*, t.title, t.type, t.status
               FROM work_sessions ws JOIN tasks t ON t.id = ws.task_id
               WHERE ws.started_at < ? AND (ws.ended_at IS NULL OR ws.ended_at > ?)
               ORDER BY ws.started_at DESC LIMIT 500""",
            (day_start_ms(1), timeline_start),
        ).fetchall()]
        for session in timeline_sessions:
            clipped_start = max(int(session["started_at"]), timeline_start)
            clipped_end = min(int(session["ended_at"] or timestamp), day_start_ms(1))
            session["recorded_minutes"] = working_minutes_between(clipped_start, clipped_end)
        timeline_progress = [dict(row) for row in db.execute(
            """SELECT p.*, t.title, t.type FROM progress_updates p
               JOIN tasks t ON t.id = p.task_id
               WHERE p.created_at >= ? AND p.created_at < ?
               ORDER BY p.created_at DESC LIMIT 300""",
            (timeline_start, day_start_ms(1)),
        ).fetchall()]
        scores = workflow.daily_scores(db, today())
        first_submission_scores = workflow.first_submission_scores(db, today())
        report_images.attach_metadata(db, progress_updates)
        report_files.attach_metadata(db, progress_updates)
        report_images.attach_metadata(db, timeline_progress)
        report_files.attach_metadata(db, timeline_progress)
        groups = task_groups(db)
        reports = [dict(row) for row in db.execute("SELECT assignee, summary, submitted_at FROM daily_reports WHERE report_date = ? ORDER BY assignee", (today(),)).fetchall()]
        tomorrow_tasks = [dict(row) for row in db.execute("SELECT id, assignee, title, type, status, estimated_minutes, planned_points FROM tasks WHERE planned_date = ? ORDER BY assignee, created_at", (date_string(1),)).fetchall()]
    return {"scores": scores, "first_submission_scores": first_submission_scores, "date": today(), "tomorrow_date": date_string(1), "server_time": timestamp, "tasks": tasks, "all_tasks": all_tasks, "groups": groups, "sessions": sessions, "progress_updates": progress_updates, "timeline_events": timeline_events, "timeline_sessions": timeline_sessions, "timeline_progress": timeline_progress, "reports": reports, "tomorrow_tasks": tomorrow_tasks}


def analysis_context(period: str) -> dict[str, object]:
    """Build a bounded, read-only management snapshot for the AI analyst."""
    if period not in ("today", "week"):
        raise ValueError("分析范围只能选择今日或近 7 天。")
    days = 1 if period == "today" else 7
    start_offset = 0 if period == "today" else -6
    start_ms = day_start_ms(start_offset)
    end_ms = day_start_ms(1)
    start_date = date_string(start_offset)
    end_date = today()
    timestamp = now_ms()
    member_names = {code: name for name, code in EMPLOYEE_NAMES.items()}

    with DB_LOCK, connect() as db:
        promote_due_tasks(db, None, timestamp)
        all_rows = db.execute(
            """SELECT * FROM tasks
               WHERE status NOT IN ('已完成', '已关闭')
                  OR (completed_at >= ? AND completed_at < ?)
                  OR (planned_date >= ? AND planned_date <= ?)
               ORDER BY updated_at DESC""",
            (start_ms, end_ms, start_date, end_date),
        ).fetchall()
        tasks = []
        for row in all_rows[:120]:
            task = dict(row)
            tasks.append(
                {
                    "id": task["id"],
                    "成员": member_names.get(task["assignee"], task["assignee"]),
                    "任务": task["title"],
                    "类型": task["type"],
                    "状态": "已暂停" if task["status"] == "进行中" and task["is_paused"] else task["status"],
                    "优先级": task["priority"],
                    "计划日期": task["planned_date"],
                    "预计分钟": task["estimated_minutes"],
                    "累计实际分钟": actual_minutes(db, task["id"], timestamp),
                    "阻塞原因": (task["blocked_reason"] or "")[:500],
                    "完成说明": (task["result_summary"] or "")[:600],
                    "验收结果": (task["acceptance_result"] or "")[:500],
                    "返工次数": task["rework_count"],
                    "最终得分": task.get("awarded_points"),
                    "完成时间": task["completed_at"],
                }
            )

        progress = [
            {
                "成员": member_names.get(row["assignee"], row["assignee"]),
                "任务": row["title"],
                "汇报状态": row["report_status"],
                "进展": (row["summary"] or "")[:500],
                "下一步": (row["next_step"] or "")[:400],
                "问题": (row["blocker"] or "")[:400],
                "进度百分比": row["progress_percent"],
                "时间": row["created_at"],
            }
            for row in db.execute(
                """SELECT p.*, t.title FROM progress_updates p
                   JOIN tasks t ON t.id = p.task_id
                   WHERE p.created_at >= ? AND p.created_at < ?
                   ORDER BY p.created_at DESC LIMIT 120""",
                (start_ms, end_ms),
            ).fetchall()
        ]
        reports = [
            {
                "日期": row["report_date"],
                "成员": member_names.get(row["assignee"], row["assignee"]),
                "总结": (row["summary"] or "")[:1200],
            }
            for row in db.execute(
                """SELECT assignee, report_date, summary FROM daily_reports
                   WHERE report_date >= ? AND report_date <= ?
                   ORDER BY report_date DESC, assignee""",
                (start_date, end_date),
            ).fetchall()
        ]
        period_minutes = {member: 0 for member in MEMBERS}
        for row in db.execute(
            """SELECT assignee, started_at, ended_at FROM work_sessions
               WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)""",
            (end_ms, start_ms),
        ).fetchall():
            clipped_start = max(int(row["started_at"]), start_ms)
            clipped_end = min(int(row["ended_at"] or timestamp), end_ms)
            period_minutes[row["assignee"]] += working_minutes_between(clipped_start, clipped_end)
        scores = workflow.daily_scores(db, today(), days)

    status_order = ("今日待办", "进行中", "已暂停", "待验收", "需修改", "阻塞", "已完成", "已关闭")
    people = []
    for member in MEMBERS:
        own_rows = [row for row in all_rows if row["assignee"] == member]
        own_statuses = ["已暂停" if row["status"] == "进行中" and row["is_paused"] else row["status"] for row in own_rows]
        own_scores = [row for row in scores if row["assignee"] == member]
        people.append(
            {
                "成员": member_names[member],
                "当前及范围内任务状态": {status: own_statuses.count(status) for status in status_order},
                "范围内完成任务数": sum(int(row["completed_count"]) for row in own_scores),
                "范围内最终得分": round(sum(float(row["points"]) for row in own_scores), 2),
                "范围内有效工时分钟": period_minutes[member],
                "范围内进展汇报数": sum(item["成员"] == member_names[member] for item in progress),
            }
        )

    return {
        "分析范围": "今日" if period == "today" else "近 7 天",
        "开始日期": start_date,
        "结束日期": end_date,
        "生成时间戳": timestamp,
        "统计说明": [
            "最终得分按审核通过日期统计，大任务不重复计分。",
            "范围内有效工时按工作时段内的计时会话裁剪统计。",
            "任务累计实际分钟是该任务全部历史计时，不等同于范围内工时。",
            "当前未完成任务会纳入，以便识别风险；已完成任务只纳入所选范围。",
        ],
        "人员汇总": people,
        "任务明细": tasks,
        "任务明细是否截断": len(all_rows) > len(tasks),
        "进展汇报": progress,
        "每日总结": reports,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "GameTeamBoard/1.0"

    def employee_member(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie["team_employee"].value
        except (KeyError, ValueError):
            return None
        with connect() as db:
            row = db.execute("SELECT member FROM employee_sessions WHERE token_hash = ? AND expires_at > ?", (hashlib.sha256(token.encode()).hexdigest(), now_ms())).fetchone()
        return row[0] if row else None

    def employee_post(self, path):
        try:
            if self.headers.get("X-Team-Request") != "employee":
                self.send_json(403, {"error": "请从员工页面提交。"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            limit = max(report_images.MAX_REQUEST_BYTES, report_files.MAX_REQUEST_BYTES) if path == "/api/employee/heartbeat" else task_files.MAX_REQUEST_BYTES if path == "/api/employee/action" else 65536
            if path == "/api/employee/heartbeat" and not self.employee_member():
                self.send_json(401, {"error": "请先填写姓名进入。"})
                return
            if not 0 < length <= limit:
                raise ValueError("提交内容过大或为空。")
            data = json.loads(self.rfile.read(length))
            if path == "/api/employee/login":
                member = EMPLOYEE_NAMES.get(str(data.get("name", "")).strip())
                if not member:
                    raise ValueError("请填写已登记的完整姓名。")
                token = secrets.token_urlsafe(32)
                with DB_LOCK, connect() as db:
                    db.execute("DELETE FROM employee_sessions WHERE expires_at <= ?", (now_ms(),))
                    db.execute("INSERT INTO employee_sessions VALUES (?, ?, ?)", (hashlib.sha256(token.encode()).hexdigest(), member, now_ms() + 30 * 86400000))
                self._employee_cookie = f"team_employee={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000" + ("; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else "")
                self.send_json(200, {"ok": True, "member": member, "role": member_role(member), "is_admin": member == "YWH"})
                return
            member = self.employee_member()
            if not member:
                self.send_json(401, {"error": "请先填写姓名进入。"})
                return
            if path == "/api/employee/logout":
                self._employee_cookie = "team_employee=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
                self.send_json(200, {"ok": True})
                return
            if path == "/api/employee/heartbeat":
                result = call_tool(member, "work_report_heartbeat", data)
                self.send_json(200, {"ok": True, "message": result["content"][0]["text"]})
                return
            if path == "/api/employee/plan":
                self.send_json(200, {"plan": generate_plan(data.get("source_text"), member)})
                return
            if path == "/api/employee/create-plan":
                self.send_json(200, create_task_group(member, data))
                return
            if path == "/api/employee/append-plan":
                self.send_json(200, append_task_group(member, data))
                return
            if path == "/api/employee/analysis-chat":
                if member != "YWH":
                    raise ValueError("只有负责人可以使用团队 AI 分析。")
                period = str(data.get("period", ""))
                answer = generate_analysis(analysis_context(period), data.get("messages"), member)
                self.send_json(200, {"answer": answer, "period": period, "generated_at": now_ms()})
                return
            if path == '/api/employee/score':
                if member != 'YWH':
                    raise ValueError('只有负责人可以请求平台 AI 评分。')
                task_id = str(data.get('task_id', ''))
                with DB_LOCK, connect() as db:
                    row = db.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone()
                    if not row or row['status'] != '待验收':
                        raise ValueError('请选择待验收任务。')
                    source = {k:row[k] for k in ('title','type','deliverable_expectation','acceptance_criteria','result_summary')}
                    submitted = row['submitted_at']
                score = generate_score(json.dumps(source, ensure_ascii=False), member)
                with DB_LOCK, connect() as db:
                    changed = db.execute("UPDATE tasks SET platform_ai_points=?,platform_ai_reason=? WHERE id=? AND status='待验收' AND submitted_at=?", (score['points'],score['reason'],task_id,submitted)).rowcount
                    if not changed:
                        raise ValueError('任务已变化，请刷新后重试。')
                    event(db,task_id,member,'平台 AI 建议评分','待验收','待验收',json.dumps(score,ensure_ascii=False),now_ms())
                self.send_json(200, score)
                return
            allowed = {"owner_insert_task", "owner_review_task", "owner_review_group", "owner_close_task", "owner_set_task_score", "work_set_high_priority", "work_unblock_task", "work_withdraw_submission","work_create_tasks", "work_start_task", "work_pause_task", "work_resume_task", "work_block_task", "work_finish_task", "work_update_submission", "work_report_heartbeat", "work_submit_daily_report"}
            name = data.get("action")
            if name not in allowed:
                raise ValueError("不支持的员工操作。")
            result = call_tool(member, name, data.get("args") or {})
            self.send_json(200, {"ok": True, "message": result["content"][0]["text"], "result": result["structuredContent"]})
        except (ValueError, TypeError, AttributeError) as exc:
            self.send_json(400, {"error": str(exc)})

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def send_bytes(self, status: int, body: bytes, content_type: str, extra_headers=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if getattr(self, "_employee_cookie", None):
            self.send_header("Set-Cookie", self._employee_cookie)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        for header, value in (extra_headers or {}).items():
            self.send_header(header, value)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-protocol-version")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, data: object) -> None:
        self.send_bytes(status, json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(), "application/json; charset=utf-8")

    def do_OPTIONS(self) -> None:
        self.send_bytes(HTTPStatus.NO_CONTENT, b"", "text/plain")

    def do_GET(self) -> None:
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        download = parse_qs(parsed_url.query).get("download") == ["1"]
        if path in ("/employee", "/employee/", "/employee.html"):
            self.send_bytes(200, (STATIC / "employee.html").read_bytes(), "text/html; charset=utf-8")
        elif path in ("/employee.js", "/employee.css", "/employee/employee.js", "/employee/employee.css"):
            filename = path.rsplit("/", 1)[1]
            self.send_bytes(200, (STATIC / filename).read_bytes(), "text/javascript; charset=utf-8" if filename.endswith(".js") else "text/css; charset=utf-8")
        elif path.rsplit("/", 1)[-1] in ("report-images.js", "report-images.css") and path in ("/report-images.js", "/report-images.css", "/employee/report-images.js", "/employee/report-images.css"):
            filename = path.rsplit("/", 1)[-1]
            self.send_bytes(200, (STATIC / filename).read_bytes(), "text/javascript; charset=utf-8" if filename.endswith(".js") else "text/css; charset=utf-8")
        elif path == "/api/employee/me":
            member = self.employee_member()
            if not member:
                self.send_json(401, {"error": "请先填写姓名进入。"})
                return
            with DB_LOCK, connect() as db:
                promote_due_tasks(db, member, now_ms())
                tasks = [dict(row) for row in db.execute("SELECT * FROM tasks WHERE assignee = ? AND status NOT IN ('已完成', '已关闭') ORDER BY CASE WHEN priority='高' THEN 0 ELSE 1 END, created_at DESC", (member,))]
                for task in tasks:
                    task["actual_minutes"] = actual_minutes(db, task["id"], now_ms())
                groups = task_groups(db, member)
                for group in groups:
                    group["tasks"] = [task for task in group["tasks"] if task["status"] != "已关闭"]
                scores = [row for row in workflow.daily_scores(db, today()) if row['assignee'] == member]
                today_score_details = [dict(row) for row in db.execute(
                    """SELECT t.id, t.title, t.group_id, g.title AS group_title,
                              t.awarded_points, t.completed_at
                       FROM tasks t LEFT JOIN task_groups g ON g.id = t.group_id
                       WHERE t.assignee = ? AND t.status = '已完成'
                         AND t.completed_at >= ? AND t.completed_at < ?
                       ORDER BY COALESCE(g.created_at, t.created_at), t.group_order, t.created_at""",
                    (member, day_start_ms(), day_start_ms(1)),
                )]
                completed = [dict(row) for row in db.execute("SELECT id,title,status,awarded_points,acceptance_result,result_summary,completed_at FROM tasks WHERE assignee=? AND status='已完成' ORDER BY completed_at DESC LIMIT 30", (member,))]
                progress = [dict(row) for row in db.execute("SELECT p.id,p.task_id,t.title,p.report_status,p.summary,p.created_at FROM progress_updates p JOIN tasks t ON t.id=p.task_id WHERE p.assignee=? AND t.assignee=? ORDER BY p.created_at DESC LIMIT 20", (member, member))]
                report_images.attach_metadata(db, progress)
                report_files.attach_metadata(db, progress)
                task_files.attach_metadata(db, tasks)
                task_files.attach_metadata(db, completed)
            self.send_json(200, {"groups": groups, "name": next(n for n, m in EMPLOYEE_NAMES.items() if m == member), "member": member, "role": member_role(member), "is_admin": member == "YWH", "date": today(), "scores": scores, "today_score_details": today_score_details, "completed": completed, "progress": progress, "tasks": tasks, "server_time": now_ms()})
        elif path.startswith("/api/task-files/"):
            member = self.employee_member()
            if not member:
                self.send_json(401, {"error": "请先登录员工页面下载附件。"})
                return
            with connect() as db:
                row = db.execute(
                    "SELECT a.body,a.content_type,a.name FROM task_attachments a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND (t.assignee=? OR ?='YWH')",
                    (path.rsplit("/", 1)[-1], member, member),
                ).fetchone()
            if row:
                safe_name = row["name"].replace('"', "'").replace("\r", "").replace("\n", "")
                extra_headers = None
                if download or not row["content_type"].startswith("image/"):
                    extra_headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(safe_name)}"}
                self.send_bytes(200, row["body"], row["content_type"], extra_headers)
            else:
                self.send_json(404, {"error": "附件不存在或无权下载。"})
        elif path.startswith("/api/report-images/"):
            member = self.employee_member()
            if not member:
                self.send_json(401, {"error": "请先登录员工页面查看图片。"})
                return
            with connect() as db:
                row = db.execute("SELECT i.body,i.content_type,i.name FROM progress_images i JOIN progress_updates p ON p.id=i.progress_id WHERE i.id=? AND (p.assignee=? OR ?='YWH')",
                                 (path.rsplit("/", 1)[-1], member, member)).fetchone()
            if row:
                extra_headers = None
                if download:
                    safe_name = row["name"].replace('"', "'").replace("\r", "").replace("\n", "")
                    extra_headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(safe_name)}"}
                self.send_bytes(200, row["body"], row["content_type"], extra_headers)
            else:
                self.send_json(404, {"error": "图片不存在或无权查看。"})
        elif path.startswith("/api/report-files/"):
            member = self.employee_member()
            if not member:
                self.send_json(401, {"error": "请先登录员工页面下载附件。"})
                return
            with connect() as db:
                row = db.execute("SELECT a.body,a.content_type,a.name FROM progress_attachments a JOIN progress_updates p ON p.id=a.progress_id WHERE a.id=? AND (p.assignee=? OR ?='YWH')",
                                 (path.rsplit("/", 1)[-1], member, member)).fetchone()
            if row:
                safe_name = row["name"].replace('"', "'").replace("\r", "").replace("\n", "")
                self.send_bytes(200, row["body"], row["content_type"], {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(safe_name)}"})
            else:
                self.send_json(404, {"error": "压缩包不存在或无权下载。"})
        elif path == "/api/work-mcp":
            self.send_json(405, {"error": "Method not allowed"})
        elif path == "/health":
            self.send_json(HTTPStatus.OK, {"ok": True, "service": "西游团队生产看板"})
        elif path == "/api/checkin-reminder":
            member = actor_for(self.headers.get("Authorization"))
            if not member:
                self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
                return
            timestamp = now_ms()
            with DB_LOCK, connect() as db:
                status = checkin_status(db, member, timestamp)
            if not status.get("due"):
                self.send_bytes(HTTPStatus.NO_CONTENT, b"", "text/plain")
                return
            reminder_slot = (timestamp - int(status["next_due_at"])) // CHECKIN_INTERVAL_MS
            key = f"{status['task_id']}:{status['next_due_at']}:{reminder_slot}"
            self.send_bytes(HTTPStatus.OK, key.encode(), "text/plain; charset=utf-8")
        elif path == "/api/dashboard":
            self.send_json(HTTPStatus.OK, dashboard_data())
        elif path in ("/", "/index.html"):
            self.send_bytes(HTTPStatus.OK, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif path == "/app.js":
            self.send_bytes(HTTPStatus.OK, (STATIC / "app.js").read_bytes(), "text/javascript; charset=utf-8")
        elif path == "/styles.css":
            self.send_bytes(HTTPStatus.OK, (STATIC / "styles.css").read_bytes(), "text/css; charset=utf-8")
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:
        if urlparse(self.path).path in ("/api/employee/login", "/api/employee/logout", "/api/employee/action", "/api/employee/plan", "/api/employee/create-plan", "/api/employee/append-plan", "/api/employee/score", "/api/employee/analysis-chat", "/api/employee/heartbeat"):
            self.employee_post(urlparse(self.path).path)
            return
        if urlparse(self.path).path != "/api/work-mcp":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        member = actor_for(self.headers.get("Authorization"))
        if not member:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
            return
        handle_post(self, member, TOOLS, call_tool)


def main() -> None:
    global DB_PATH
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4312)
    parser.add_argument("--database", type=Path, default=Path("tasks.db"))
    args = parser.parse_args()
    DB_PATH = args.database
    initialize_database()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"西游团队生产看板 listening on {args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
