import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import app


SHANGHAI = ZoneInfo("Asia/Shanghai")


def stamp(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=SHANGHAI).timestamp() * 1000)


class DashboardTimeDetailsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "tasks.db"
        app.initialize_database()

    def tearDown(self):
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def test_dashboard_tasks_include_each_session_start_and_end(self):
        started = stamp("2026-09-16T09:30:00")
        ended = stamp("2026-09-16T09:45:00")
        with patch.object(app, "now_ms", return_value=started):
            task_id = app.call_tool(
                "YWH",
                "owner_insert_task",
                {
                    "assignee": "ZHC",
                    "title": "展示用时详情",
                    "acceptance_criteria": "显示计时区间",
                },
            )["structuredContent"]["task_id"]
        with patch.object(app, "now_ms", return_value=started):
            app.call_tool("ZHC", "work_start_task", {"task_id": task_id})
        with patch.object(app, "now_ms", return_value=ended):
            app.call_tool("ZHC", "work_finish_task", {"task_id": task_id, "summary": "已完成", "employee_points": 0})

        with patch.object(app, "now_ms", return_value=ended):
            task = next(task for task in app.dashboard_data()["tasks"] if task["id"] == task_id)

        self.assertEqual(len(task["time_sessions"]), 1)
        self.assertEqual(task["time_sessions"][0]["started_at"], started)
        self.assertEqual(task["time_sessions"][0]["ended_at"], ended)


if __name__ == "__main__":
    unittest.main()
