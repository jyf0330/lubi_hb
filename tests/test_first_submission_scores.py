import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import app
import workflow


def stamp(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=ZoneInfo('Asia/Shanghai')).timestamp() * 1000)


class FirstSubmissionScoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / 'tasks.db'
        app.initialize_database()

    def tearDown(self):
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def call(self, name, args, member='ZHC'):
        return app.call_tool(member, name, args)['structuredContent']

    def test_first_score_survives_rework_and_workday_range_skips_weekends(self):
        task_id = self.call('owner_insert_task', {
            'title': '首次自评分统计',
            'assignee': 'ZHC',
            'acceptance_criteria': '验证首次分数固定',
        }, 'YWH')['task_id']
        first_submitted = stamp('2026-09-14T09:45:00')
        second_submitted = stamp('2026-09-14T10:45:00')

        with patch.object(app, 'now_ms', return_value=stamp('2026-09-14T09:30:00')):
            self.call('work_start_task', {'task_id': task_id})
        with patch.object(app, 'now_ms', return_value=first_submitted):
            self.call('work_finish_task', {
                'task_id': task_id,
                'summary': '第一次提交',
                'employee_points': 4,
            })
        with patch.object(app, 'now_ms', return_value=stamp('2026-09-14T10:00:00')):
            self.call('owner_review_task', {
                'task_id': task_id,
                'decision': 'rework',
                'reason': '补充后重提',
            }, 'YWH')
        with patch.object(app, 'now_ms', return_value=stamp('2026-09-14T10:15:00')):
            self.call('work_start_task', {'task_id': task_id})
        with patch.object(app, 'now_ms', return_value=second_submitted):
            self.call('work_finish_task', {
                'task_id': task_id,
                'summary': '返工后第二次提交',
                'employee_points': 9,
            })

        with app.connect() as db:
            task = db.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone()
            self.assertEqual(task['employee_ai_points'], 9)
            self.assertEqual(task['first_submitted_points'], 4)
            self.assertEqual(task['first_submitted_at'], first_submitted)

            scores = workflow.first_submission_scores(db, '2026-09-15')
            first_day = next(row for row in scores if row['date'] == '2026-09-14' and row['assignee'] == 'ZHC')
            self.assertEqual(first_day['points'], 4)
            self.assertEqual(first_day['submitted_count'], 1)

            weekend_range = workflow.first_submission_scores(db, '2026-09-20')
            dates = list(dict.fromkeys(row['date'] for row in weekend_range))
            self.assertEqual(dates, ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'])

            db.execute('UPDATE tasks SET first_submitted_points=NULL WHERE id=?', (task_id,))
        app.initialize_database()
        self.assertIsNone(self._task(task_id)['first_submitted_points'])

    def _task(self, task_id):
        with app.connect() as db:
            return db.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone()


if __name__ == '__main__':
    unittest.main()
