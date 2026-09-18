import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import app
import task_planner


def sample():
    names = ['需求分析与素材规划', '提示词设计与AI生成', '素材筛选与优化', '素材整理与规范化', '成果检查与汇总']
    return {'group': {'title': '制作游戏像素风美术素材', 'deliverable_expectation': '分类PNG素材包及生成记录', 'acceptance_criteria': '风格统一，待补充数量和尺寸'},
            'stated_minutes': 480, 'tasks': [{'title': name, 'type': '美术', 'estimated_minutes': minutes, 'deliverable_expectation': '阶段成果', 'acceptance_criteria': '符合规划清单'} for name, minutes in zip(names, [60, 180, 120, 60, 60])], 'warnings': ['请确认素材数量和尺寸']}


class Plans(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / 'tasks.db'
        app.initialize_database()
        self.data = {'request_id': 'test-request', 'source_text': '原文计划，预计8小时', 'plan': sample()}

    def tearDown(self):
        app.DB_PATH = self.old
        self.temp.cleanup()

    def test_create_atomic_idempotent_and_no_double_count(self):
        result = app.create_task_group('ZHC', self.data)
        self.assertEqual(app.create_task_group('ZHC', self.data)['group_id'], result['group_id'])
        with app.connect() as db:
            self.assertEqual(db.execute('select count(*) from task_groups').fetchone()[0], 1)
            self.assertEqual(db.execute('select count(*) from tasks').fetchone()[0], 5)
            self.assertEqual(db.execute('select sum(estimated_minutes) from tasks').fetchone()[0], 480)
            self.assertEqual(db.execute('select sum(planned_points) from tasks').fetchone()[0], 8)
            self.assertEqual(db.execute('select count(*) from work_sessions').fetchone()[0], 0)
            self.assertEqual(app.task_groups(db, 'YWT'), [])
            self.assertEqual(app.task_groups(db, 'ZHC')[0]['status'], '今日待办')
        changed = copy.deepcopy(self.data); changed['plan']['group']['title'] = '另一项'
        with self.assertRaises(ValueError): app.create_task_group('ZHC', changed)
        app.create_task_group('YWT', self.data)
        self.assertEqual(len(app.dashboard_data()['tasks']), 10)

    def test_invalid_final_child_leaves_no_parent(self):
        self.data['plan']['tasks'][-1]['estimated_minutes'] = True
        with self.assertRaises(ValueError): app.create_task_group('ZHC', self.data)
        with app.connect() as db:
            self.assertEqual(db.execute('select count(*) from task_groups').fetchone()[0], 0)
            self.assertEqual(db.execute('select count(*) from tasks').fetchone()[0], 0)
        self.data['plan'] = sample()
        with patch.object(app, 'event', side_effect=RuntimeError('forced transaction failure')):
            with self.assertRaises(RuntimeError): app.create_task_group('ZHC', self.data)
        with app.connect() as db:
            self.assertEqual(db.execute('select count(*) from task_groups').fetchone()[0], 0)
            self.assertEqual(db.execute('select count(*) from tasks').fetchone()[0], 0)

    def test_parent_reference_can_differ_from_child_estimates(self):
        for minutes in [None, True, 1.5, '60', 0, 1441]:
            plan = sample(); plan['tasks'][0]['estimated_minutes'] = minutes
            with self.assertRaises(ValueError): task_planner.validate_plan(plan, True)
        plan = sample(); plan['stated_minutes'] = 600
        self.assertEqual(task_planner.validate_plan(plan, True)['stated_minutes'], 600)
        result = app.create_task_group('ZHC', {'request_id': 'different-estimate', 'source_text': '粗略估时', 'plan': plan})
        with app.connect() as db:
            group = app.task_groups(db, 'ZHC')[0]
            self.assertEqual(result['group_id'], group['id'])
            self.assertEqual(group['stated_minutes'], 600)
            self.assertEqual(group['estimated_minutes'], 480)
        plan = sample(); plan['tasks'][0]['estimated_minutes'] = None
        self.assertIsNone(task_planner.validate_plan(plan)['tasks'][0]['estimated_minutes'])
        plan = sample(); plan['tasks'][0]['title'] = 'x' * 121
        with self.assertRaises(ValueError): task_planner.validate_plan(plan, True)

    def test_child_lifecycle_and_rollup(self):
        app.create_task_group('ZHC', self.data)
        with app.connect() as db: children = app.task_groups(db, 'ZHC')[0]['tasks']
        child = children[0]['id']
        with self.assertRaises(ValueError): app.call_tool('YWT', 'work_start_task', {'task_id': child})
        app.call_tool('ZHC', 'work_start_task', {'task_id': child})
        with app.connect() as db: self.assertEqual(app.task_groups(db, 'ZHC')[0]['status'], '进行中')
        app.call_tool('ZHC', 'work_finish_task', {'task_id': child, 'summary': '已完成规划', 'employee_points': 0, 'deliverable_urls': []})
        with app.connect() as db:
            db.execute("update tasks set status='待验收'")
            self.assertEqual(app.task_groups(db, 'ZHC')[0]['status'], '待验收')
            db.execute("update tasks set status='已完成'")
            group = app.task_groups(db, 'ZHC')[0]
            self.assertEqual(group['status'], '已完成')
            self.assertEqual(group['completed_count'], 5)
        app.initialize_database()  # repeated additive migration preserves data
        with app.connect() as db: self.assertEqual(db.execute('select count(*) from tasks').fetchone()[0], 5)

    def test_append_group_preserves_history_and_updates_child_rollup(self):
        app.create_task_group('ZHC', self.data)
        with app.connect() as db:
            group_id = app.task_groups(db, 'ZHC')[0]['id']
            original = db.execute('select id, status, created_at from tasks where group_id=? order by group_order limit 1', (group_id,)).fetchone()
        append_payload = {
            'group_id': group_id,
            'request_id': 'append-1',
            'reason': '原计划漏写成果检查步骤',
            'estimate_updates': [{'task_id': original['id'], 'estimated_minutes': 75}],
            'tasks': [{'title': '补充成果检查', 'type': '测试', 'estimated_minutes': 30,
                       'deliverable_expectation': '检查记录', 'acceptance_criteria': '记录可复核'}],
        }
        result = app.append_task_group('ZHC', append_payload)
        retry = app.append_task_group('ZHC', append_payload)
        self.assertEqual(result['added_count'], 1)
        self.assertEqual(retry['message'], '该补充已登记，未重复创建。')
        self.assertEqual(result['updated_count'], 1)
        self.assertEqual(result['updated_minutes_delta'], 15)
        self.assertEqual(result['estimated_minutes'], 525)
        with app.connect() as db:
            children = db.execute('select * from tasks where group_id=? order by group_order', (group_id,)).fetchall()
            self.assertEqual(len(children), 6)
            self.assertEqual(children[0]['id'], original['id'])
            self.assertEqual(children[0]['status'], original['status'])
            self.assertEqual(children[0]['created_at'], original['created_at'])
            self.assertEqual(children[0]['estimated_minutes'], 75)
            self.assertEqual(children[-1]['title'], '补充成果检查')
            self.assertEqual(json.loads(children[-1]['notes'])['append_reason'], '原计划漏写成果检查步骤')
            event = db.execute("select event_type, detail from task_events where task_id=? order by created_at desc limit 1", (children[-1]['id'],)).fetchone()
            self.assertEqual(event['event_type'], '补充小任务')
            self.assertIn('补充前小任务合计 495 分钟，补充后 525 分钟', event['detail'])
            adjustment_event = db.execute("select event_type, detail from task_events where task_id=? and event_type='调整预计时间' order by created_at desc limit 1", (children[0]['id'],)).fetchone()
            self.assertIn('预计 60 → 75 分钟', adjustment_event['detail'])
            group = app.task_groups(db, 'ZHC')[0]
            self.assertEqual(group['estimated_minutes'], 525)
            self.assertEqual(group['child_estimated_minutes'], 525)
            self.assertEqual(group['stated_minutes'], 480)

    def test_append_group_requires_owner_and_maximum(self):
        app.create_task_group('ZHC', self.data)
        with app.connect() as db: group_id = app.task_groups(db, 'ZHC')[0]['id']
        payload = {'group_id': group_id, 'reason': '补录', 'tasks': [{'title': '不应创建', 'type': '测试', 'estimated_minutes': 15, 'deliverable_expectation': '记录', 'acceptance_criteria': '可复核'}]}
        with self.assertRaisesRegex(ValueError, '找不到属于当前成员'):
            app.append_task_group('YWT', payload)
        with app.connect() as db:
            first_id = db.execute('select id from tasks where group_id=? order by group_order limit 1', (group_id,)).fetchone()['id']
            db.execute("update tasks set status='已完成' where id=?", (first_id,))
        with self.assertRaisesRegex(ValueError, '已经提交或验收'):
            app.append_task_group('ZHC', {'group_id': group_id, 'reason': '补录', 'estimate_updates': [{'task_id': first_id, 'estimated_minutes': 90}], 'tasks': [payload['tasks'][0]]})
        too_many = copy.deepcopy(self.data['plan']['tasks'])
        too_many[0] = dict(too_many[0], title='第六项')
        too_many.append({'title': '第七项', 'type': '美术', 'estimated_minutes': 15, 'deliverable_expectation': '成果', 'acceptance_criteria': '可复核'})
        with self.assertRaisesRegex(ValueError, '最多保留 8 个'):
            app.append_task_group('ZHC', {'group_id': group_id, 'reason': '补录', 'tasks': too_many})
        with app.connect() as db:
            self.assertEqual(db.execute('select count(*) from tasks where group_id=?', (group_id,)).fetchone()[0], 5)

        fill = {'group_id': group_id, 'request_id': 'fill-to-eight', 'reason': '补录剩余步骤', 'tasks': [
            {'title': f'补录{i}', 'type': '测试', 'estimated_minutes': 15, 'deliverable_expectation': '记录', 'acceptance_criteria': '可复核'}
            for i in range(3)
        ]}
        app.append_task_group('ZHC', fill)
        app.append_task_group('ZHC', fill)
        with app.connect() as db:
            self.assertEqual(db.execute('select count(*) from tasks where group_id=?', (group_id,)).fetchone()[0], 8)

    def test_model_contract_and_sanitized_errors(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def read(self, n): return json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(sample())}}]}).encode()
        with patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'test-only-key'}), patch.object(task_planner, 'urlopen', return_value=Response()) as send:
            task_planner._LAST.clear()
            result = task_planner.generate_plan('做素材8小时', 'ZHC')
            self.assertEqual(result['stated_minutes'], 480)
            payload = json.loads(send.call_args.args[0].data)
            self.assertEqual(payload['model'], 'deepseek-flash')
            self.assertEqual(payload['response_format'], {'type': 'json_object'})
            self.assertEqual(payload['messages'][1]['content'], '做素材8小时')
            with self.assertRaises(ValueError): task_planner.generate_plan('再次生成', 'ZHC')
            task_planner._LAST.clear()
            send.side_effect = HTTPError('https://api.deepseek.com', 401, 'secret-provider-body', {}, None)
            with self.assertRaisesRegex(ValueError, '^AI 服务配置无效'): task_planner.generate_plan('做素材', 'ZHC')
        with patch.dict(os.environ, {'DEEPSEEK_API_KEY': ''}):
            with self.assertRaisesRegex(ValueError, '尚未配置'): task_planner.generate_plan('做素材', 'ZHC')

    def test_employee_http_auth_draft_and_confirm(self):
        class Quiet(app.Handler):
            def log_message(self, *args): pass
        server = app.ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        def post(path, data, cookie=''):
            req = Request(base + '/api/employee/' + path, data=json.dumps(data).encode(), headers={'X-Team-Request': 'employee', 'Cookie': cookie})
            try: res = urlopen(req)
            except HTTPError as exc: res = exc
            with res: return res.status, json.loads(res.read()), res.headers.get('Set-Cookie', '').split(';')[0]
        try:
            self.assertEqual(post('plan', {'source_text': '制作素材'})[0], 401)
            _, login, cookie = post('login', {'name': '赵浩丞'})
            self.assertEqual(login['role'], 'employee')
            self.assertFalse(login['is_admin'])
            with patch.object(app, 'generate_plan', return_value=sample()):
                self.assertEqual(post('plan', {'source_text': '制作素材'}, cookie)[0], 200)
            with app.connect() as db: self.assertEqual(db.execute('select count(*) from tasks').fetchone()[0], 0)
            self.assertEqual(post('create-plan', self.data, cookie)[0], 200)
            req = Request(base + '/api/employee/me', headers={'Cookie': cookie})
            with urlopen(req) as res: value = json.loads(res.read())
            self.assertEqual(value['role'], 'employee')
            self.assertFalse(value['is_admin'])
            self.assertEqual(len(value['groups']), 1)
            self.assertEqual(len(value['tasks']), 5)
            group_id = value['groups'][0]['id']
            status, appended, _ = post('append-plan', {
                'group_id': group_id,
                'request_id': 'http-append-1',
                'reason': '漏写导出检查',
                'tasks': [{'title': '导出检查', 'type': '测试', 'estimated_minutes': 30,
                           'deliverable_expectation': '导出检查记录', 'acceptance_criteria': '记录可复核'}],
            }, cookie)
            self.assertEqual(status, 200)
            self.assertEqual(appended['added_count'], 1)
            req = Request(base + '/api/employee/me', headers={'Cookie': cookie})
            with urlopen(req) as res: refreshed = json.loads(res.read())
            self.assertEqual(len(refreshed['groups'][0]['tasks']), 6)
            self.assertEqual(post('create-plan', self.data, cookie)[0], 200)
        finally:
            server.shutdown(); server.server_close(); thread.join()

if __name__ == '__main__': unittest.main()
