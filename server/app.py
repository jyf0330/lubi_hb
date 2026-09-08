#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hmac
import json
import os
import sqlite3
import threading
import time
import uuid
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
SCHEMA = ROOT / "schema.sql"
TASK_TYPES = ["美术", "测试", "文档", "配置", "资料整理", "AI任务", "其他"]
DB_PATH = Path("tasks.db")
DB_LOCK = threading.RLock()


def now_ms() -> int:
    return int(time.time() * 1000)


def today() -> str:
    return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 15000")
    return db


def initialize_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(SCHEMA.read_text(encoding="utf-8"))


def actor_for(header: str | None) -> str | None:
    if not header or not header.startswith("Bearer "):
        return None
    supplied = header[7:]
    for member, key in (("ZHC", "MCP_TOKEN_ZHC"), ("YWT", "MCP_TOKEN_YWT")):
        expected = os.environ.get(key, "")
        if expected and hmac.compare_digest(supplied, expected):
            return member
    return None


def event(db: sqlite3.Connection, task_id: str, actor: str, event_type: str, from_status: str | None, to_status: str | None, detail: str | None, timestamp: int) -> None:
    db.execute(
        "INSERT INTO task_events (id, task_id, actor, event_type, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), task_id, actor, event_type, from_status, to_status, detail, timestamp),
    )


def task_for(db: sqlite3.Connection, task_id: str, member: str) -> sqlite3.Row | None:
    return db.execute("SELECT * FROM tasks WHERE id = ? AND assignee = ?", (task_id, member)).fetchone()


def active_for(db: sqlite3.Connection, member: str) -> sqlite3.Row | None:
    return db.execute(
        """SELECT t.*, ws.id AS session_id, ws.started_at AS session_started_at
        FROM tasks t JOIN work_sessions ws ON ws.task_id = t.id
        WHERE t.assignee = ? AND t.status = '进行中' AND t.is_paused = 0 AND ws.ended_at IS NULL
        ORDER BY ws.started_at DESC LIMIT 1""",
        (member,),
    ).fetchone()


def actual_minutes(db: sqlite3.Connection, task_id: str, timestamp: int) -> int:
    row = db.execute(
        "SELECT COALESCE(SUM((COALESCE(ended_at, ?) - started_at) / 60000.0), 0) AS minutes FROM work_sessions WHERE task_id = ?",
        (timestamp, task_id),
    ).fetchone()
    return round(float(row["minutes"] if row else 0))


def tool_result(message: str, **data: object) -> dict[str, object]:
    return {"content": [{"type": "text", "text": message}], "structuredContent": {"ok": True, **data}}


TOOLS = [
    {"name": "work_get_active", "description": "查看当前员工正在计时或暂停中的任务。", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}, "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}},
    {"name": "work_create_tasks", "description": "员工确认 AI 的任务拆分后，将选中的任务登记到今日待办。", "inputSchema": {"type": "object", "properties": {"tasks": {"type": "array", "minItems": 1, "maxItems": 8, "items": {"type": "object", "required": ["title", "type", "estimated_minutes"], "properties": {"title": {"type": "string"}, "type": {"type": "string", "enum": TASK_TYPES}, "estimated_minutes": {"type": "integer", "minimum": 15, "maximum": 1440}, "deliverable_expectation": {"type": "string"}, "acceptance_criteria": {"type": "string"}, "deadline_at": {"type": "string"}, "dependency_titles": {"type": "array", "items": {"type": "string"}}, "parallel_group": {"type": "string"}}}}}, "required": ["tasks"], "additionalProperties": False}, "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}},
    {"name": "work_start_task", "description": "员工确认开始后，为指定任务打开服务器计时。", "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string", "format": "uuid"}}, "required": ["task_id"], "additionalProperties": False}},
    {"name": "work_pause_task", "description": "暂停当前任务并关闭当前计时段。", "inputSchema": {"type": "object", "properties": {"reason": {"type": "string"}}, "additionalProperties": False}},
    {"name": "work_resume_task", "description": "继续一项已暂停的任务。", "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string", "format": "uuid"}}, "required": ["task_id"], "additionalProperties": False}},
    {"name": "work_block_task", "description": "记录需求、程序、素材或权限等阻塞原因。", "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string", "format": "uuid"}, "reason": {"type": "string"}}, "required": ["task_id", "reason"], "additionalProperties": False}},
    {"name": "work_finish_task", "description": "结束计时、保存总结和交付链接并提交待验收。", "inputSchema": {"type": "object", "properties": {"task_id": {"type": "string", "format": "uuid"}, "summary": {"type": "string"}, "deliverable_urls": {"type": "array", "items": {"type": "string", "format": "uri"}}}, "required": ["task_id", "summary"], "additionalProperties": False}},
]


def call_tool(member: str, name: str, args: dict[str, object]) -> dict[str, object]:
    timestamp = now_ms()
    with DB_LOCK, connect() as db:
        if name == "work_get_active":
            task = db.execute("SELECT * FROM tasks WHERE assignee = ? AND status = '进行中' ORDER BY updated_at DESC LIMIT 1", (member,)).fetchone()
            if not task:
                return tool_result("当前没有进行中的任务。", task=None)
            value = dict(task)
            return tool_result(f"当前任务：{task['title']}{'（已暂停）' if task['is_paused'] else '（计时中）'}", task=value)

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

        task_id = str(args.get("task_id", ""))
        if name == "work_start_task":
            active = active_for(db, member)
            if active:
                raise ValueError(f"已有正在计时的任务：{active['title']}。请先暂停或完成它。")
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
            active = active_for(db, member)
            if not active:
                raise ValueError("当前没有正在计时的任务。")
            db.execute("UPDATE work_sessions SET ended_at = ?, end_reason = '暂停' WHERE id = ?", (timestamp, active["session_id"]))
            db.execute("UPDATE tasks SET is_paused = 1, updated_at = ? WHERE id = ?", (timestamp, active["id"]))
            event(db, active["id"], member, "暂停计时", "进行中", "进行中", str(args.get("reason") or "") or None, timestamp)
            return tool_result(f"已暂停：{active['title']}", task_id=active["id"], status="进行中", paused=True)

        task = task_for(db, task_id, member)
        if not task:
            raise ValueError("找不到该员工的任务。")
        if name == "work_resume_task":
            if active_for(db, member):
                raise ValueError("已有另一项任务正在计时。")
            if task["status"] != "进行中" or not task["is_paused"]:
                raise ValueError("该任务不是可继续的暂停任务。")
            db.execute("UPDATE tasks SET is_paused = 0, updated_at = ? WHERE id = ?", (timestamp, task_id))
            db.execute("INSERT INTO work_sessions (id, task_id, assignee, started_at) VALUES (?, ?, ?, ?)", (str(uuid.uuid4()), task_id, member, timestamp))
            event(db, task_id, member, "继续计时", "进行中", "进行中", None, timestamp)
            return tool_result(f"已继续：{task['title']}", task_id=task_id, status="进行中", resumed_at=timestamp)

        if name == "work_block_task":
            reason = str(args.get("reason", "")).strip()[:500]
            if len(reason) < 2:
                raise ValueError("请填写阻塞原因。")
            open_session = db.execute("SELECT id FROM work_sessions WHERE task_id = ? AND ended_at IS NULL LIMIT 1", (task_id,)).fetchone()
            if open_session:
                db.execute("UPDATE work_sessions SET ended_at = ?, end_reason = '阻塞' WHERE id = ?", (timestamp, open_session["id"]))
            db.execute("UPDATE tasks SET status = '阻塞', is_paused = 0, blocked_reason = ?, updated_at = ? WHERE id = ?", (reason, timestamp, task_id))
            event(db, task_id, member, "任务阻塞", task["status"], "阻塞", reason, timestamp)
            return tool_result(f"已标记阻塞：{task['title']}", task_id=task_id, status="阻塞", reason=reason)

        if name == "work_finish_task":
            if task["status"] != "进行中":
                raise ValueError("该任务不在进行中。")
            summary = str(args.get("summary", "")).strip()[:1200]
            if len(summary) < 2:
                raise ValueError("请填写完成总结。")
            urls = args.get("deliverable_urls") or []
            if not isinstance(urls, list) or len(urls) > 12:
                raise ValueError("交付链接格式不正确。")
            open_session = db.execute("SELECT id FROM work_sessions WHERE task_id = ? AND ended_at IS NULL LIMIT 1", (task_id,)).fetchone()
            if open_session:
                db.execute("UPDATE work_sessions SET ended_at = ?, end_reason = '提交' WHERE id = ?", (timestamp, open_session["id"]))
            db.execute("UPDATE tasks SET status = '待验收', is_paused = 0, result_summary = ?, submitted_at = ?, updated_at = ? WHERE id = ?", (summary, timestamp, timestamp, task_id))
            event(db, task_id, member, "提交验收", "进行中", "待验收", summary, timestamp)
            for index, url in enumerate(urls):
                parsed = urlparse(str(url))
                if parsed.scheme not in ("http", "https") or not parsed.netloc:
                    raise ValueError("交付链接必须是 HTTP 或 HTTPS 地址。")
                db.execute("INSERT INTO deliverables (id, task_id, kind, label, url, created_at) VALUES (?, ?, '链接', ?, ?, ?)", (str(uuid.uuid4()), task_id, f"交付物 {index + 1}", str(url), timestamp))
            minutes = actual_minutes(db, task_id, timestamp)
            return tool_result(f"已提交待验收：{task['title']}，实际记录 {minutes} 分钟。", task_id=task_id, status="待验收", actual_minutes=minutes, summary=summary, deliverables=urls)

        raise ValueError("未知工具。")


def dashboard_data() -> dict[str, object]:
    with connect() as db:
        timestamp = now_ms()
        tasks = [
            dict(row)
            for row in db.execute(
                """SELECT t.*,
                    ROUND(COALESCE((
                        SELECT SUM((COALESCE(ws.ended_at, ?) - ws.started_at) / 60000.0)
                        FROM work_sessions ws
                        WHERE ws.task_id = t.id
                    ), 0)) AS actual_minutes
                FROM tasks t
                WHERE t.planned_date = ?
                ORDER BY t.updated_at DESC""",
                (timestamp, today()),
            ).fetchall()
        ]
        sessions = [dict(row) for row in db.execute("SELECT ws.*, t.title, t.type FROM work_sessions ws JOIN tasks t ON t.id = ws.task_id WHERE t.planned_date = ? ORDER BY ws.started_at DESC LIMIT 24", (today(),)).fetchall()]
    return {"date": today(), "server_time": timestamp, "tasks": tasks, "sessions": sessions}


class Handler(BaseHTTPRequestHandler):
    server_version = "GameTeamBoard/1.0"

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
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
        path = urlparse(self.path).path
        if path == "/health":
            self.send_json(HTTPStatus.OK, {"ok": True, "service": "西游团队生产看板"})
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
        if urlparse(self.path).path != "/api/work-mcp":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        member = actor_for(self.headers.get("Authorization"))
        if not member:
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1_048_576:
                raise ValueError("请求大小不正确。")
            request = json.loads(self.rfile.read(length))
            method = request.get("method")
            request_id = request.get("id")
            if method == "initialize":
                result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "game-team-work", "version": "1.0.0"}, "instructions": "Only write after employee confirmation. Server timestamps are authoritative."}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                params = request.get("params") or {}
                result = call_tool(member, str(params.get("name", "")), params.get("arguments") or {})
            elif method == "notifications/initialized":
                self.send_bytes(HTTPStatus.ACCEPTED, b"", "text/plain")
                return
            else:
                self.send_json(HTTPStatus.OK, {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}})
                return
            self.send_json(HTTPStatus.OK, {"jsonrpc": "2.0", "id": request_id, "result": result})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.OK, {"jsonrpc": "2.0", "id": locals().get("request_id"), "error": {"code": -32602, "message": str(exc)}})
        except Exception:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"jsonrpc": "2.0", "id": locals().get("request_id"), "error": {"code": -32603, "message": "Internal server error"}})


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
