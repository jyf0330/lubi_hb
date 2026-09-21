import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import app


class SoftDeleteTaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "tasks.db"
        app.initialize_database()

    def tearDown(self):
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def call(self, name, args, member="ZHC"):
        return app.call_tool(member, name, args)["structuredContent"]

    def create(self, title="可删除任务"):
        return self.call("work_create_tasks", {"tasks": [{
            "title": title, "type": "其他", "estimated_minutes": 60,
        }]})["tasks"][0]["id"]

    def row(self, task_id):
        with app.connect() as db:
            return dict(db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def test_employee_soft_deletes_completed_task_and_owner_alone_restores_it(self):
        task_id = self.create("已经验收的任务")
        self.call("work_start_task", {"task_id": task_id})
        self.call("work_finish_task", {
            "task_id": task_id, "summary": "完成交付", "employee_points": 7,
        })
        self.call("owner_review_task", {
            "task_id": task_id, "decision": "accept", "reason": "验收通过",
        }, "YWH")

        self.assertEqual(self.row(task_id)["status"], "已完成")
        self.call("work_delete_task", {"task_id": task_id})

        deleted = self.row(task_id)
        self.assertEqual(deleted["status"], "已删除")
        self.assertEqual(deleted["deleted_from_status"], "已完成")
        self.assertEqual(deleted["deleted_by"], "ZHC")
        self.assertIsNotNone(deleted["deleted_at"])

        dashboard = app.dashboard_data()
        self.assertNotIn(task_id, [task["id"] for task in dashboard["tasks"]])
        self.assertNotIn(task_id, [task["id"] for task in dashboard["all_tasks"]])
        self.assertEqual(dashboard["deleted_tasks"], [])
        score = next(row for row in dashboard["scores"] if row["date"] == app.today() and row["assignee"] == "ZHC")
        self.assertEqual((score["points"], score["completed_count"]), (0, 0))
        first = next(row for row in dashboard["first_submission_scores"] if row["date"] == app.today() and row["assignee"] == "ZHC")
        self.assertEqual((first["points"], first["submitted_count"]), (0, 0))

        owner_dashboard = app.dashboard_data(include_deleted=True)
        owner_copy = next(task for task in owner_dashboard["deleted_tasks"] if task["id"] == task_id)
        self.assertEqual(owner_copy["deleted_from_status"], "已完成")

        with self.assertRaisesRegex(ValueError, "只有管理员"):
            self.call("owner_restore_task", {"task_id": task_id})
        restored = self.call("owner_restore_task", {"task_id": task_id}, "YWH")
        self.assertEqual(restored["status"], "已完成")
        self.assertEqual(self.row(task_id)["status"], "已完成")
        restored_score = next(row for row in app.dashboard_data()["scores"] if row["date"] == app.today() and row["assignee"] == "ZHC")
        self.assertEqual((restored_score["points"], restored_score["completed_count"]), (7, 1))

    def test_deleting_running_task_stops_timer_and_removes_work_and_hb_statistics(self):
        task_id = self.create("进行中的任务")
        self.call("work_start_task", {"task_id": task_id})
        self.call("work_report_heartbeat", {"task_id": task_id, "status": "正常推进", "detail": "正在处理"})

        self.call("work_delete_task", {"task_id": task_id})

        with app.connect() as db:
            session = db.execute("SELECT ended_at,end_reason FROM work_sessions WHERE task_id=?", (task_id,)).fetchone()
        self.assertIsNotNone(session["ended_at"])
        self.assertEqual(session["end_reason"], "员工移入删除区")
        dashboard = app.dashboard_data()
        self.assertEqual(dashboard["sessions"], [])
        self.assertEqual(dashboard["progress_updates"], [])
        self.assertEqual(dashboard["timeline_sessions"], [])
        self.assertEqual(dashboard["timeline_progress"], [])

        restored = self.call("owner_restore_task", {"task_id": task_id}, "YWH")
        self.assertEqual(restored["status"], "进行中")
        self.assertTrue(restored["paused"])
        self.assertEqual(self.row(task_id)["is_paused"], 1)

    def test_employee_cannot_delete_another_members_task(self):
        task_id = self.create("别人的任务")
        with self.assertRaisesRegex(ValueError, "只能删除自己的任务"):
            self.call("work_delete_task", {"task_id": task_id}, "YWT")


if __name__ == "__main__":
    unittest.main()
