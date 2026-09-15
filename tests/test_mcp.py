"""Run with BOARD_APP_SOURCE pointing at the current app.py (never its database)."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from mcp_protocol import handle_post


class McpIntegration(unittest.TestCase):
    def setUp(self):
        source = Path(os.environ.get("BOARD_APP_SOURCE", ROOT / "server/app.py"))
        spec = importlib.util.spec_from_file_location("board_test_app", source)
        self.app = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.app)
        self.temp = tempfile.TemporaryDirectory()
        self.app.DB_PATH = Path(self.temp.name) / "test.db"
        self.app.initialize_database()
        app = self.app

        class Handler(app.Handler):
            def do_POST(self):
                member = app.actor_for(self.headers.get("Authorization"))
                if not member:
                    self.send_json(401, {"error": "Unauthorized"})
                    return
                handle_post(self, member, app.TOOLS, app.call_tool)

            def log_message(self, *args):
                pass

        self.env = patch.dict(os.environ, {f"MCP_TOKEN_{m}": f"test-only-{m}" for m in app.MEMBERS})
        self.env.start()
        self.server = app.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/work-mcp"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.env.stop()
        self.temp.cleanup()

    def send(self, body, member="ZHC", origin=None):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": f"Bearer test-only-{member}"}
        if origin:
            headers["Origin"] = origin
        request = Request(self.url, data=json.dumps(body).encode(), headers=headers)
        try:
            response = urlopen(request)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None

    def rpc(self, method, params=None, member="ZHC"):
        return self.send({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, member)[1]

    def tool(self, name, args=None, member="ZHC"):
        return self.rpc("tools/call", {"name": name, "arguments": args or {}}, member)

    def create(self):
        return self.tool("work_create_tasks", {"tasks": [{"title": "隔离测试任务", "type": "测试", "estimated_minutes": 30}]})["result"]["structuredContent"]["tasks"][0]["id"]

    def test_handshake_auth_and_notifications(self):
        self.assertEqual(self.rpc("initialize")["result"]["protocolVersion"], "2025-03-26")
        self.assertEqual(self.rpc("ping")["result"], {})
        names = {t["name"] for t in self.rpc("tools/list")["result"]["tools"]}
        self.assertTrue({"work_report_heartbeat", "work_submit_daily_report"} <= names)
        self.assertEqual(self.send({}, "unknown")[0], 401)
        self.assertEqual(self.send({}, origin="https://untrusted.example")[0], 403)
        self.assertEqual(self.send({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "work_create_tasks"}}), (202, None))
        with self.app.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

    def test_invalid_requests(self):
        for value in ([], 12, None, {"jsonrpc": "1.0", "method": "ping", "id": 1}):
            self.assertEqual(self.send(value)[1]["error"]["code"], -32600)
        self.assertEqual(self.tool("missing")["error"]["code"], -32602)
        self.assertEqual(self.tool("work_get_active", {"member": "YWH"})["error"]["code"], -32602)
        self.assertEqual(self.tool("work_create_tasks", {"tasks": [{"title": "x", "type": "测试", "estimated_minutes": True}]})["error"]["code"], -32602)

    def test_task_lifecycle_and_identity(self):
        task = self.create()
        other = self.create()
        self.assertTrue(self.tool("work_start_task", {"task_id": task}, "YWT")["result"]["isError"])
        self.tool("work_start_task", {"task_id": task})
        self.assertTrue(self.tool("work_start_task", {"task_id": other})["result"]["structuredContent"]["ok"])
        self.assertTrue(self.tool("work_pause_task")["result"]["isError"])
        self.tool("work_pause_task", {"task_id": other})
        hb = self.tool("work_report_heartbeat", {"status": "遇到问题", "detail": "素材未到"})["result"]["structuredContent"]
        self.assertEqual(hb["next_due_at"] - hb["created_at"], 1800000)
        self.assertIsNone(hb["progress_percent"])
        self.assertEqual(self.tool("work_get_active")["result"]["structuredContent"]["task"]["status"], "进行中")
        self.tool("work_pause_task")
        self.assertTrue(self.tool("work_report_heartbeat", {"status": "正常推进"})["result"]["isError"])
        self.tool("work_resume_task", {"task_id": task})
        done = self.tool("work_finish_task", {"task_id": task, "summary": "完成隔离验证"})["result"]["structuredContent"]
        self.assertEqual(done["status"], "待验收")
        self.assertIn("submitted_at", done)
        remaining = self.tool("work_get_active")["result"]["structuredContent"]["tasks"]
        self.assertEqual([t["id"] for t in remaining], [other])
        self.assertTrue(remaining[0]["is_paused"])

    def test_append_group_tool_is_atomic_and_idempotent(self):
        group = self.app.create_task_group("ZHC", {
            "request_id": "mcp-group-1",
            "source_text": "拆分测试",
            "plan": {
                "group": {"title": "MCP 补拆测试", "deliverable_expectation": "测试交付", "acceptance_criteria": "可复核"},
                "stated_minutes": 30,
                "tasks": [{"title": "原始小任务", "type": "测试", "estimated_minutes": 30, "deliverable_expectation": "原始记录", "acceptance_criteria": "可复核"}],
                "warnings": [],
            },
        })
        with self.app.connect() as db:
            group_id = group["group_id"]
            original_id = db.execute("select id from tasks where group_id=?", (group_id,)).fetchone()["id"]
        args = {"group_id": group_id, "request_id": "mcp-append-1", "reason": "漏写检查步骤", "estimate_updates": [{"task_id": original_id, "estimated_minutes": 45}], "tasks": [{"title": "补充检查", "type": "测试", "estimated_minutes": 15, "deliverable_expectation": "检查记录", "acceptance_criteria": "可复核"}]}
        result = self.tool("work_append_group_tasks", args)["result"]["structuredContent"]
        self.assertEqual(result["estimated_minutes"], 60)
        retry_response = self.tool("work_append_group_tasks", args)["result"]
        self.assertEqual(retry_response["content"][0]["text"], "该补充已登记，未重复创建。")
        with self.app.connect() as db:
            self.assertEqual(db.execute("select count(*) from tasks where group_id=?", (group_id,)).fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
