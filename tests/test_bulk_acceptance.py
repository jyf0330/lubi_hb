import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import app


SHANGHAI = ZoneInfo("Asia/Shanghai")


def stamp(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=SHANGHAI).timestamp() * 1000)


class BulkAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "tasks.db"
        app.initialize_database()

    def tearDown(self):
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def call(self, member, name, args):
        return app.call_tool(member, name, args)["structuredContent"]

    def submit_standalone(self, member, title, score):
        task_id = self.call(
            "YWH",
            "owner_insert_task",
            {
                "title": title,
                "assignee": member,
                "acceptance_criteria": "可复核",
                "estimated_minutes": 30,
            },
        )["task_id"]
        self.call(member, "work_start_task", {"task_id": task_id})
        self.call(
            member,
            "work_finish_task",
            {"task_id": task_id, "summary": "已完成", "employee_points": score},
        )
        return task_id

    def test_owner_can_accept_all_eligible_tasks_and_incomplete_group_stays_pending(self):
        first = self.submit_standalone("ZHC", "独立任务一", 2)
        second = self.submit_standalone("YWT", "独立任务二", 3)
        plan = {
            "request_id": "partial-group",
            "source_text": "分组任务",
            "plan": {
                "group": {"title": "分组任务", "deliverable_expectation": "成果", "acceptance_criteria": "可复核"},
                "stated_minutes": 60,
                "tasks": [
                    {"title": "阶段一", "type": "其他", "estimated_minutes": 30, "deliverable_expectation": "一", "acceptance_criteria": "一"},
                    {"title": "阶段二", "type": "其他", "estimated_minutes": 30, "deliverable_expectation": "二", "acceptance_criteria": "二"},
                ],
            },
        }
        group_id = app.create_task_group("ZHC", plan)["group_id"]
        with app.connect() as db:
            group_tasks = db.execute("SELECT id FROM tasks WHERE group_id=? ORDER BY group_order", (group_id,)).fetchall()
        self.call("ZHC", "work_start_task", {"task_id": group_tasks[0]["id"]})
        self.call("ZHC", "work_finish_task", {"task_id": group_tasks[0]["id"], "summary": "阶段完成", "employee_points": 4})

        summary = app.dashboard_data()["bulk_review"]
        self.assertEqual((summary["eligible_count"], summary["eligible_points"]), (2, 5))
        self.assertEqual(summary["skipped_count"], 1)
        with self.assertRaisesRegex(ValueError, "只有负责人"):
            self.call("ZHC", "owner_review_all", {})
        result = self.call("YWH", "owner_review_all", {})
        self.assertEqual((result["accepted_count"], result["points"], result["skipped_count"]), (2, 5, 1))

        with app.connect() as db:
            accepted = db.execute("SELECT id,status,awarded_points FROM tasks WHERE id IN (?,?) ORDER BY id", (first, second)).fetchall()
            partial = db.execute("SELECT status FROM tasks WHERE id=?", (group_tasks[0]["id"],)).fetchone()
            events = db.execute("SELECT actor,detail FROM task_events WHERE task_id IN (?,?) AND event_type='审核通过'", (first, second)).fetchall()
        self.assertTrue(all(row["status"] == "已完成" for row in accepted))
        self.assertEqual(sum(row["awarded_points"] for row in accepted), 5)
        self.assertEqual(partial["status"], "待验收")
        self.assertTrue(all(row["actor"] == "YWH" and '"batch_review": true' in row["detail"] for row in events))

    def test_2330_job_runs_once_and_catches_up_after_restart(self):
        first = self.submit_standalone("ZHC", "晚间待验收", 6)
        before = app.run_scheduled_auto_review(stamp("2026-09-22T23:29:59"))
        self.assertFalse(before["ran"])

        result = app.run_scheduled_auto_review(stamp("2026-09-22T23:30:00"))
        self.assertTrue(result["ran"])
        self.assertEqual((result["accepted_count"], result["points"]), (1, 6))
        repeat = app.run_scheduled_auto_review(stamp("2026-09-22T23:59:00"))
        self.assertEqual((repeat["ran"], repeat["reason"]), (False, "already_ran"))

        second = self.submit_standalone("YWT", "当晚运行后提交", 2)
        same_night = app.run_scheduled_auto_review(stamp("2026-09-22T23:59:30"))
        self.assertFalse(same_night["ran"])
        next_day = app.run_scheduled_auto_review(stamp("2026-09-23T23:45:00"))
        self.assertEqual((next_day["ran"], next_day["accepted_count"], next_day["points"]), (True, 1, 2))

        with app.connect() as db:
            rows = db.execute("SELECT id,status,acceptance_result FROM tasks WHERE id IN (?,?) ORDER BY id", (first, second)).fetchall()
            actors = db.execute("SELECT DISTINCT actor FROM task_events WHERE event_type='审核通过'").fetchall()
        self.assertTrue(all(row["status"] == "已完成" and row["acceptance_result"] == "23:30 自动一键验收" for row in rows))
        self.assertEqual({row["actor"] for row in actors}, {"系统（23:30自动）"})

    def test_batch_skips_frozen_history_and_invalid_legacy_score(self):
        frozen = self.submit_standalone("ZHC", "冻结前任务", 3)
        invalid = self.submit_standalone("YWT", "旧版异常分数", 4)
        with app.connect() as db:
            db.execute("UPDATE tasks SET created_at=? WHERE id=?", (app.day_start_ms(-1), frozen))
            db.execute("UPDATE tasks SET employee_ai_points=2.5 WHERE id=?", (invalid,))
            db.execute(
                "INSERT INTO board_settings(key,value,updated_at,updated_by) VALUES ('data_freeze_date',?,?,?)",
                (app.today(), app.now_ms(), "YWH"),
            )

        summary = app.dashboard_data()["bulk_review"]
        self.assertEqual(summary["eligible_count"], 0)
        self.assertEqual(summary["pending_count"], 1)
        self.assertEqual(summary["invalid_score_count"], 1)
        with self.assertRaisesRegex(ValueError, "当前没有可一键验收"):
            self.call("YWH", "owner_review_all", {})
        with app.connect() as db:
            rows = db.execute("SELECT id,status FROM tasks WHERE id IN (?,?)", (frozen, invalid)).fetchall()
        self.assertTrue(all(row["status"] == "待验收" for row in rows))


if __name__ == "__main__":
    unittest.main()
