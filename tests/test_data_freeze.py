import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import app


class DataFreezeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "tasks.db"
        app.initialize_database()

    def tearDown(self):
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def create_task(self, title, timestamp):
        with patch.object(app, "now_ms", return_value=timestamp):
            return app.call_tool(
                "ZHC",
                "work_create_tasks",
                {"tasks": [{"title": title, "type": "测试", "estimated_minutes": 60}]},
            )["structuredContent"]["tasks"][0]["id"]

    def test_freeze_hides_old_work_without_deleting_it_and_blocks_stale_actions(self):
        old_timestamp = app.day_start_ms(-1) + 10 * 60 * 60 * 1000
        old_task = self.create_task("冻结前任务", old_timestamp)

        with patch.object(app, "now_ms", return_value=old_timestamp + 60_000):
            app.call_tool("ZHC", "work_start_task", {"task_id": old_task})
        with patch.object(app, "now_ms", return_value=old_timestamp + 120_000):
            app.call_tool(
                "ZHC",
                "work_report_heartbeat",
                {"task_id": old_task, "status": "正常推进", "detail": "冻结前进展"},
            )

        with app.connect() as db:
            result = app.save_data_freeze(db, "YWH", app.today(), app.now_ms())
        self.assertEqual(result["freeze_date"], app.today())

        new_task = self.create_task("冻结后任务", app.now_ms())
        dashboard = app.dashboard_data()
        self.assertEqual(dashboard["freeze_date"], app.today())
        self.assertIn(new_task, [task["id"] for task in dashboard["all_tasks"]])
        self.assertNotIn(old_task, [task["id"] for task in dashboard["all_tasks"]])
        self.assertNotIn(old_task, [item["task_id"] for item in dashboard["timeline_progress"]])

        with app.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM tasks WHERE id=?", (old_task,)).fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM progress_updates WHERE task_id=?", (old_task,)).fetchone()[0], 1)

        with self.assertRaisesRegex(ValueError, "早于数据冻结日期"):
            app.call_tool("ZHC", "work_pause_task", {"task_id": old_task})

        context = app.analysis_context("week")
        self.assertNotIn("冻结前任务", [task["任务"] for task in context["任务明细"]])
        self.assertIn("冻结后任务", [task["任务"] for task in context["任务明细"]])

    def test_only_admin_can_set_freeze_date_over_http(self):
        old_task = self.create_task("接口冻结前任务", app.day_start_ms(-1) + 60_000)
        server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"

        def post(path, data, cookie=""):
            request = Request(
                base + path,
                data=json.dumps(data).encode(),
                headers={"Content-Type": "application/json", "X-Team-Request": "employee", "Cookie": cookie},
            )
            with urlopen(request) as response:
                return json.load(response), response.headers.get("Set-Cookie", "").split(";", 1)[0]

        try:
            _, worker_cookie = post("/api/employee/login", {"name": "赵浩丞"})
            with self.assertRaises(HTTPError) as unauthorized:
                post("/api/employee/freeze", {"freeze_date": app.today()}, worker_cookie)
            self.assertEqual(unauthorized.exception.code, 400)
            unauthorized.exception.close()

            _, owner_cookie = post("/api/employee/login", {"name": "余文浩"})
            frozen, _ = post("/api/employee/freeze", {"freeze_date": app.today()}, owner_cookie)
            self.assertEqual(frozen["freeze_date"], app.today())

            with urlopen(Request(base + "/api/employee/me", headers={"Cookie": worker_cookie})) as response:
                employee = json.load(response)
            self.assertEqual(employee["freeze_date"], app.today())
            self.assertNotIn(old_task, [task["id"] for task in employee["tasks"]])

            with urlopen(base + "/api/dashboard") as response:
                dashboard = json.load(response)
            self.assertEqual(dashboard["freeze_date"], app.today())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_future_and_noncanonical_dates_are_rejected(self):
        with app.connect() as db:
            with self.assertRaisesRegex(ValueError, "正确的数据冻结日期"):
                app.save_data_freeze(db, "YWH", "2026-9-2", app.now_ms())
            with self.assertRaisesRegex(ValueError, "不能晚于今天"):
                app.save_data_freeze(db, "YWH", app.date_string(1), app.now_ms())


if __name__ == "__main__":
    unittest.main()
