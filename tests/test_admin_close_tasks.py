import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import app


class AdminCloseTaskTests(unittest.TestCase):
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

    def task(self, task_id):
        with app.connect() as db:
            return dict(db.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone())

    def blocked_task(self):
        task_id = self.call('work_create_tasks', {'tasks': [{
            'title': '等待权限的任务', 'type': '其他', 'estimated_minutes': 60,
        }]})['tasks'][0]['id']
        self.call('work_block_task', {'task_id': task_id, 'reason': '等待权限开通'})
        return task_id

    def test_admin_can_close_blocked_task_and_audit_reason(self):
        task_id = self.blocked_task()

        result = self.call('owner_close_task', {
            'task_id': task_id, 'reason': '改由其他方案处理',
        }, 'YWH')

        self.assertEqual(result['status'], '已关闭')
        self.assertEqual(self.task(task_id)['status'], '已关闭')
        with app.connect() as db:
            event = db.execute(
                "SELECT actor, from_status, to_status, detail FROM task_events WHERE task_id=? AND event_type='管理员关闭任务'",
                (task_id,),
            ).fetchone()
        self.assertEqual(tuple(event), ('YWH', '阻塞', '已关闭', '改由其他方案处理'))
        dashboard_task = next(
            task for task in app.dashboard_data()['all_tasks'] if task['id'] == task_id
        )
        self.assertEqual(dashboard_task['close_reason'], '改由其他方案处理')
        self.assertEqual(dashboard_task['closed_by'], 'YWH')

    def test_admin_can_close_rework_but_employee_cannot(self):
        task_id = self.call('owner_insert_task', {
            'title': '退回修改的任务', 'assignee': 'ZHC',
            'acceptance_criteria': '按要求修改',
        }, 'YWH')['task_id']
        self.call('work_start_task', {'task_id': task_id})
        self.call('work_finish_task', {
            'task_id': task_id, 'summary': '提交修改', 'employee_points': 0,
        })
        self.call('owner_review_task', {
            'task_id': task_id, 'decision': 'rework', 'reason': '需要补充说明',
        }, 'YWH')

        with self.assertRaisesRegex(ValueError, '只有负责人'):
            self.call('owner_close_task', {'task_id': task_id}, 'ZHC')

        self.call('owner_close_task', {'task_id': task_id}, 'YWH')
        self.assertEqual(self.task(task_id)['status'], '已关闭')

    def test_only_blocked_or_rework_tasks_can_be_closed(self):
        task_id = self.call('work_create_tasks', {'tasks': [{
            'title': '普通待办', 'type': '其他', 'estimated_minutes': 60,
        }]})['tasks'][0]['id']

        with self.assertRaisesRegex(ValueError, '只有阻塞或需修改'):
            self.call('owner_close_task', {'task_id': task_id}, 'YWH')

    def test_admin_api_closes_task_and_dashboard_lists_it(self):
        import json
        import threading
        from urllib.request import Request, urlopen

        task_id = self.blocked_task()
        server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'

        def post(path, data, cookie=''):
            request = Request(
                base + path,
                data=json.dumps(data).encode(),
                headers={
                    'Content-Type': 'application/json',
                    'X-Team-Request': 'employee',
                    'Cookie': cookie,
                },
            )
            with urlopen(request) as response:
                return json.load(response), response.headers.get('Set-Cookie', '').split(';')[0]

        try:
            _, owner_cookie = post('/api/employee/login', {'name': '余文浩'})
            post('/api/employee/action', {
                'action': 'owner_close_task',
                'args': {'task_id': task_id, 'reason': '已取消需求'},
            }, owner_cookie)
            with urlopen(base + '/api/dashboard') as response:
                dashboard = json.load(response)
            closed_task = next(task for task in dashboard['all_tasks'] if task['id'] == task_id)
            self.assertEqual(closed_task['status'], '已关闭')
            self.assertEqual(closed_task['close_reason'], '已取消需求')

            _, worker_cookie = post('/api/employee/login', {'name': '赵浩丞'})
            with urlopen(Request(base + '/api/employee/me', headers={'Cookie': worker_cookie})) as response:
                employee = json.load(response)
            self.assertNotIn(task_id, [task['id'] for task in employee['tasks']])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
