import json
import os
import sys
import tempfile
import threading
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import app
import team_analyst


SHANGHAI = ZoneInfo("Asia/Shanghai")


def stamp(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=SHANGHAI).timestamp() * 1000)


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload, ensure_ascii=False).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self.payload


class TeamAnalystTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "tasks.db"
        app.initialize_database()

    def tearDown(self):
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def test_context_contains_real_today_summary_and_task_details(self):
        now = stamp("2026-09-21T10:00:00")
        with patch.object(app, "now_ms", return_value=now), patch.object(app, "today", return_value="2026-09-21"), patch.object(app, "date_string", side_effect=lambda offset=0: {0: "2026-09-21", -6: "2026-09-15", 1: "2026-09-22"}[offset]), patch.object(app, "day_start_ms", side_effect=lambda offset=0: {0: stamp("2026-09-21T00:00:00"), -6: stamp("2026-09-15T00:00:00"), 1: stamp("2026-09-22T00:00:00")}[offset]):
            task_id = app.call_tool(
                "YWH",
                "owner_insert_task",
                {"assignee": "ZHC", "title": "修复战斗结算", "estimated_minutes": 90, "acceptance_criteria": "测试通过"},
            )["structuredContent"]["task_id"]
            context = app.analysis_context("today")

        task = next(item for item in context["任务明细"] if item["id"] == task_id)
        self.assertEqual(context["分析范围"], "今日")
        self.assertEqual(task["成员"], "赵浩丞")
        self.assertEqual(task["任务"], "修复战斗结算")
        self.assertIn("范围内有效工时分钟", context["人员汇总"][0])

    def test_context_rejects_unknown_period(self):
        with self.assertRaisesRegex(ValueError, "今日或近 7 天"):
            app.analysis_context("month")

    def test_generate_analysis_sends_snapshot_and_conversation(self):
        response = FakeResponse({"choices": [{"finish_reason": "stop", "message": {"content": "今日有一项待处理风险。"}}]})
        captured = {}

        def fake_urlopen(request, timeout):
            captured["body"] = json.loads(request.data)
            captured["timeout"] = timeout
            return response

        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key", "DEEPSEEK_MODEL": "deepseek-flash"}), patch.object(team_analyst, "urlopen", side_effect=fake_urlopen), patch.object(team_analyst, "_ACTIVE", set()):
            answer = team_analyst.generate_analysis(
                {"分析范围": "今日", "任务明细": []},
                [{"role": "user", "content": "分析今天"}],
                member="test-owner",
            )

        self.assertEqual(answer, "今日有一项待处理风险。")
        self.assertEqual(captured["timeout"], 45)
        self.assertIn("只读看板快照", captured["body"]["messages"][1]["content"])
        self.assertEqual(captured["body"]["messages"][-1]["content"], "分析今天")
        self.assertNotIn("test-key", json.dumps(captured["body"], ensure_ascii=False))

    def test_immediate_follow_up_is_allowed_after_previous_answer(self):
        response = FakeResponse({"choices": [{"finish_reason": "stop", "message": {"content": "可以继续追问。"}}]})
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key"}), patch.object(team_analyst, "urlopen", return_value=response) as request, patch.object(team_analyst, "_ACTIVE", set()):
            first = team_analyst.generate_analysis(
                {"分析范围": "今日"},
                [{"role": "user", "content": "先分析今天"}],
                member="same-owner",
            )
            second = team_analyst.generate_analysis(
                {"分析范围": "今日"},
                [
                    {"role": "user", "content": "先分析今天"},
                    {"role": "assistant", "content": first},
                    {"role": "user", "content": "马上继续追问"},
                ],
                member="same-owner",
            )

        self.assertEqual(second, "可以继续追问。")
        self.assertEqual(request.call_count, 2)

    def test_validate_messages_limits_and_requires_user_last(self):
        with self.assertRaises(ValueError):
            team_analyst.validate_messages([])
        with self.assertRaisesRegex(ValueError, "最后一条"):
            team_analyst.validate_messages([{"role": "assistant", "content": "回答"}])
        with self.assertRaises(ValueError):
            team_analyst.validate_messages([{"role": "user", "content": "x" * 2001}])

    def test_analysis_http_requires_owner_session_and_returns_answer(self):
        server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"

        def post(path, data, cookie=""):
            request = Request(
                base + path,
                data=json.dumps(data, ensure_ascii=False).encode(),
                headers={"Content-Type": "application/json", "X-Team-Request": "employee", "Cookie": cookie},
            )
            with urlopen(request) as response:
                return json.load(response), response.headers.get("Set-Cookie", "").split(";")[0]

        payload = {"period": "week", "messages": [{"role": "user", "content": "总结这一周"}]}
        try:
            _, owner_cookie = post("/api/employee/login", {"name": "余文浩"})
            _, worker_cookie = post("/api/employee/login", {"name": "赵浩丞"})
            with self.assertRaises(HTTPError) as denied:
                post("/api/employee/analysis-chat", payload, worker_cookie)
            self.assertEqual(denied.exception.code, 400)
            denied.exception.close()

            with patch.object(app, "generate_analysis", return_value="本周整体稳定。") as mocked:
                result, _ = post("/api/employee/analysis-chat", payload, owner_cookie)
            self.assertEqual(result["answer"], "本周整体稳定。")
            self.assertEqual(result["period"], "week")
            self.assertEqual(mocked.call_args.args[0]["分析范围"], "近 7 天")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
