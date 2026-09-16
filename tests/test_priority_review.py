import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import app
import task_planner


SHANGHAI = ZoneInfo('Asia/Shanghai')


def stamp(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=SHANGHAI).timestamp() * 1000)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name)/'tasks.db'
        app.initialize_database()

    def tearDown(self):
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def call(self, name, args, member='ZHC'):
        return app.call_tool(member, name, args)['structuredContent']

    def insert(self, title='临时调整'):
        return self.call('owner_insert_task', {'title':title,'assignee':'ZHC','acceptance_criteria':'完成指定调整'}, 'YWH')['task_id']

    def task(self, task_id):
        with app.connect() as db:
            return dict(db.execute('SELECT * FROM tasks WHERE id=?',(task_id,)).fetchone())

    def submit(self, task_id, **extra):
        self.call('work_start_task', {'task_id':task_id})
        self.call('work_finish_task', {'task_id':task_id, 'summary':'完成了要求的调整', **extra})

    def test_single_priority_replacement_and_restart(self):
        first,second=self.insert(),self.insert('第二次插单')
        self.assertEqual(self.task(first)['priority'],'普通')
        self.call('work_set_high_priority',{'task_id':first})
        self.call('work_start_task',{'task_id':first})
        self.call('work_set_high_priority',{'task_id':second})
        self.assertEqual(self.task(first)['priority'],'普通')
        self.assertEqual(self.task(first)['status'],'进行中')
        app.initialize_database()
        self.assertEqual(self.task(second)['priority'],'高')
        with app.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM task_events WHERE task_id=? AND event_type='高优先被替换'",(first,)).fetchone()[0],1)

    def test_authority_and_normal_tasks(self):
        with self.assertRaises(ValueError):self.call('owner_insert_task',{'title':'伪造插单'})
        task_id=self.insert()
        with self.assertRaises(ValueError):self.call('work_set_high_priority',{'task_id':task_id},'YWT')
        normal=self.call('work_create_tasks',{'tasks':[{'title':'普通工作','type':'其他','estimated_minutes':60}]})['tasks'][0]['id']
        with self.assertRaises(ValueError):self.call('work_set_high_priority',{'task_id':normal})
        self.submit(task_id)
        with self.assertRaises(ValueError):self.call('owner_review_task',{'task_id':task_id,'decision':'accept','points':3})

    def test_parallel_pause_targets_and_heartbeat(self):
        first,second=self.insert(),self.insert()
        for t in (first,second):self.call('work_start_task',{'task_id':t})
        with self.assertRaises(ValueError):self.call('work_pause_task',{})
        with self.assertRaises(ValueError):self.call('work_report_heartbeat',{'status':'正常推进'})
        result=self.call('work_report_heartbeat',{'task_id':first,'status':'正常推进'})
        self.assertEqual(result['task_id'],first)
        with app.connect() as db:
            self.assertIn(app.checkin_status(db,'ZHC',app.now_ms())['task_id'],(first,second))
        self.call('work_pause_task',{'task_id':first})
        self.assertFalse(self.task(second)['is_paused'])
        self.call('work_resume_task',{'task_id':first})
        self.assertEqual(len(self.call('work_get_active',{})['tasks']),2)

    def test_review_wait_not_counted_rework_preserves_time(self):
        task_id=self.insert()
        with patch.object(app,'now_ms',return_value=stamp('2026-09-14T09:30:00')):self.call('work_start_task',{'task_id':task_id})
        with patch.object(app,'now_ms',return_value=stamp('2026-09-14T09:40:00')):self.call('work_finish_task',{'task_id':task_id,'summary':'初次完成'})
        with app.connect() as db:self.assertEqual(app.actual_minutes(db,task_id,stamp('2026-09-14T18:30:00')),10)
        self.call('owner_review_task',{'task_id':task_id,'decision':'rework','reason':'补充细节'},'YWH')
        with patch.object(app,'now_ms',return_value=stamp('2026-09-14T14:00:00')):self.call('work_start_task',{'task_id':task_id})
        with patch.object(app,'now_ms',return_value=stamp('2026-09-14T14:15:00')):self.call('work_finish_task',{'task_id':task_id,'summary':'修改完成'})
        with app.connect() as db:self.assertEqual(app.actual_minutes(db,task_id,stamp('2026-09-14T18:30:00')),25)
        self.assertEqual(self.task(task_id)['rework_count'],1)

    def test_employee_can_withdraw_pending_submission_and_resubmit(self):
        task_id = self.insert()
        started = stamp('2026-09-14T09:30:00')
        submitted = stamp('2026-09-14T09:45:00')
        with patch.object(app, 'now_ms', return_value=started):
            self.call('work_start_task', {'task_id': task_id})
        with patch.object(app, 'now_ms', return_value=submitted):
            self.call('work_finish_task', {'task_id': task_id, 'summary': '初次完成但需要重写'})

        with patch.object(app, 'now_ms', return_value=stamp('2026-09-14T10:00:00')):
            result = self.call('work_withdraw_submission', {'task_id': task_id})
        self.assertTrue(result['ok'])
        reopened = self.task(task_id)
        self.assertEqual(reopened['status'], '进行中')
        self.assertEqual(reopened['is_paused'], 1)
        self.assertIsNone(reopened['submitted_at'])
        self.assertIsNone(reopened['result_summary'])
        with app.connect() as db:
            self.assertEqual(app.actual_minutes(db, task_id, stamp('2026-09-14T18:30:00')), 15)
            event_row = db.execute(
                "SELECT from_status,to_status,event_type FROM task_events WHERE task_id=? AND event_type='员工撤回验收'",
                (task_id,),
            ).fetchone()
            self.assertEqual(tuple(event_row), ('待验收', '进行中', '员工撤回验收'))

        with self.assertRaises(ValueError):
            self.call('work_withdraw_submission', {'task_id': task_id}, 'YWT')
        self.call('work_resume_task', {'task_id': task_id})
        self.call('work_finish_task', {'task_id': task_id, 'summary': '重写后的完成说明'})
        self.assertEqual(self.task(task_id)['status'], '待验收')

    def test_employee_cannot_withdraw_processed_submission(self):
        task_id = self.insert()
        self.submit(task_id)
        self.call('owner_review_task', {'task_id': task_id, 'decision': 'accept', 'points': 2}, 'YWH')
        with self.assertRaisesRegex(ValueError, '只有尚未处理'):
            self.call('work_withdraw_submission', {'task_id': task_id})

    def test_working_minutes_use_weekday_windows_and_boundaries(self):
        cases = [
            ('2026-09-14T09:00:00', '2026-09-14T10:00:00', 30),
            ('2026-09-14T11:50:00', '2026-09-14T14:10:00', 20),
            ('2026-09-17T18:00:00', '2026-09-18T10:00:00', 60),
            ('2026-09-18T18:00:00', '2026-09-21T10:00:00', 60),
            ('2026-09-14T09:30:00', '2026-09-14T12:00:00', 150),
            ('2026-09-14T12:00:00', '2026-09-14T14:00:00', 0),
            ('2026-09-14T14:00:00', '2026-09-14T18:30:00', 270),
            ('2026-09-19T09:30:00', '2026-09-19T18:30:00', 0),
        ]
        for start, end, expected in cases:
            self.assertEqual(app.working_minutes_between(stamp(start), stamp(end)), expected, (start, end))

    def test_off_hours_session_stays_active_but_does_not_accumulate(self):
        task_id = self.insert()
        start = stamp('2026-09-14T12:30:00')
        with patch.object(app, 'now_ms', return_value=start):
            result = self.call('work_start_task', {'task_id': task_id})
        self.assertEqual(result['status'], '进行中')
        with app.connect() as db:
            self.assertEqual(app.actual_minutes(db, task_id, stamp('2026-09-14T13:30:00')), 0)
            self.assertEqual(app.actual_minutes(db, task_id, stamp('2026-09-14T14:10:00')), 10)

    def test_historical_session_recalculates_without_changing_raw_timestamps(self):
        task_id = self.insert()
        started = stamp('2026-09-14T11:50:00')
        ended = stamp('2026-09-14T14:10:00')
        with app.connect() as db:
            db.execute('INSERT INTO work_sessions (id,task_id,assignee,started_at,ended_at,end_reason) VALUES (?,?,?,?,?,?)', ('history', task_id, 'ZHC', started, ended, '提交'))
            self.assertEqual(app.actual_minutes(db, task_id, ended), 20)
            row = db.execute('SELECT started_at,ended_at FROM work_sessions WHERE id=?', ('history',)).fetchone()
            self.assertEqual((row['started_at'], row['ended_at']), (started, ended))

    def test_hb_due_uses_working_minutes(self):
        task_id = self.insert()
        with patch.object(app, 'now_ms', return_value=stamp('2026-09-14T11:50:00')):
            self.call('work_start_task', {'task_id': task_id})
        with app.connect() as db:
            lunchtime = app.checkin_status(db, 'ZHC', stamp('2026-09-14T13:59:00'), task_id)
            self.assertFalse(lunchtime['due'])
            after = app.checkin_status(db, 'ZHC', stamp('2026-09-14T14:20:00'), task_id)
            self.assertTrue(after['due'])
            self.assertEqual(after['next_due_at'], stamp('2026-09-14T14:20:00'))
            self.assertEqual(after['remaining_minutes'], 0)

    def test_scoring_is_manual_cross_day_and_idempotent(self):
        task_id=self.insert()
        with app.connect() as db:db.execute('UPDATE tasks SET planned_date=? WHERE id=?',(app.date_string(-3),task_id))
        self.submit(task_id,employee_ai_points=8,employee_ai_reason='员工 AI 认为复杂')
        self.assertIsNone(self.task(task_id)['awarded_points'])
        for invalid in [True,-1,3.5,float('nan'),float('inf'),'3']:
            with self.assertRaises(ValueError):self.call('owner_review_task',{'task_id':task_id,'decision':'accept','points':invalid},'YWH')
        self.call('owner_review_task',{'task_id':task_id,'decision':'accept','points':0},'YWH')
        with self.assertRaises(ValueError):self.call('owner_review_task',{'task_id':task_id,'decision':'accept','points':5},'YWH')
        data=app.dashboard_data()
        self.assertTrue(any(t['id']==task_id for t in data['tasks']))
        score=next(r for r in data['scores'] if r['date']==app.today() and r['assignee']=='ZHC')
        self.assertEqual(score['points'],0)
        self.assertEqual(score['completed_count'],1)
        self.assertEqual(score['unscored_count'],0)
        with app.connect() as db:self.assertEqual(app.day_snapshot(db,'ZHC',app.today(),app.now_ms())['completed_points'],0)

    def test_employee_and_platform_suggestions_require_integer_points(self):
        finish_schema = next(tool for tool in app.TOOLS if tool['name'] == 'work_finish_task')
        self.assertEqual(finish_schema['inputSchema']['properties']['employee_ai_points']['type'], 'integer')
        self.assertIn('step="1"', (app.STATIC / 'employee.html').read_text())
        self.assertIn('最终点数（整数，0 也算）', (app.STATIC / 'app.js').read_text())

        employee_task = self.insert()
        self.call('work_start_task', {'task_id': employee_task})
        with self.assertRaisesRegex(ValueError, '整数'):
            self.call('work_finish_task', {
                'task_id': employee_task,
                'summary': '完成了要求的调整',
                'employee_ai_points': 1.5,
                'employee_ai_reason': '建议分说明',
            })
        self.call('work_finish_task', {
            'task_id': employee_task,
            'summary': '完成了要求的调整',
            'employee_ai_points': 0,
            'employee_ai_reason': '0 点也是有效建议',
        })
        self.assertEqual(self.task(employee_task)['employee_ai_points'], 0)

        with patch.object(task_planner, 'generate_plan', side_effect=lambda source, member, prompt, validator: validator({'points': 2.5, 'reason': '非整数'})):
            with self.assertRaisesRegex(ValueError, '整数'):
                task_planner.generate_score('{"title":"工作"}', 'YWH')

    def test_terminal_block_prohibited_and_unblock(self):
        task_id=self.insert()
        self.call('work_block_task',{'task_id':task_id,'reason':'等待素材'})
        self.call('work_unblock_task',{'task_id':task_id})
        self.submit(task_id)
        with self.assertRaises(ValueError):self.call('work_block_task',{'task_id':task_id,'reason':'绕过审核'})

    def test_legacy_points_not_silently_awarded(self):
        task_id=self.insert()
        with app.connect() as db:db.execute("UPDATE tasks SET status='已完成',completed_at=?,planned_points=99 WHERE id=?",(app.now_ms(),task_id))
        app.initialize_database()
        row=next(r for r in app.dashboard_data()['scores'] if r['date']==app.today() and r['assignee']=='ZHC')
        self.assertEqual(row['points'],0)
        self.assertEqual(row['unscored_count'],1)

    def test_platform_suggestion_validation(self):
        def generate(source,member,prompt,validator):
            self.assertNotIn('employee_ai_points',source)
            return validator({'points':5,'reason':'交付范围较复杂，只有文字，待负责人核验'})
        with patch.object(task_planner,'generate_plan',side_effect=generate):
            self.assertEqual(task_planner.generate_score('{"title":"工作"}','YWH')['points'],5)

    def test_http_platform_score_and_role_enforcement(self):
        import threading, json
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}/api/employee/'
        def post(path,data,cookie=''):
            request=Request(base+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','X-Team-Request':'employee','Cookie':cookie})
            try:
                with urlopen(request) as response:
                    return json.load(response), response.headers.get('Set-Cookie','').split(';')[0]
            except HTTPError as error:
                error.close()
                raise
        try:
            owner_login,owner=post('login',{'name':'余文浩'})
            self.assertEqual(owner_login['role'],'admin')
            self.assertTrue(owner_login['is_admin'])
            _,worker=post('login',{'name':'赵浩丞'})
            task_id=self.insert();self.submit(task_id)
            with self.assertRaises(HTTPError):post('score',{'task_id':task_id},worker)
            with patch.object(app,'generate_score',return_value={'points':5,'reason':'平台模型建议，待审核'}):
                post('score',{'task_id':task_id},owner)
            self.assertEqual(self.task(task_id)['platform_ai_points'],5)
            self.assertIsNone(self.task(task_id)['awarded_points'])
            with self.assertRaises(HTTPError):post('action',{'action':'owner_review_task','args':{'task_id':task_id,'decision':'accept','points':5}},worker)
            post('action',{'action':'owner_review_task','args':{'task_id':task_id,'decision':'accept','points':2}},owner)
            self.assertEqual(self.task(task_id)['awarded_points'],2)
            def profile(cookie):
                with urlopen(Request(base+'me?member=YWH',headers={'Cookie':cookie})) as response:
                    return json.load(response)
            worker_data=profile(worker)
            owner_data=profile(owner)
            self.assertEqual(worker_data['member'],'ZHC')
            self.assertEqual(worker_data['name'],'赵浩丞')
            self.assertEqual([t['id'] for t in worker_data['completed']],[task_id])
            self.assertEqual(sum(r['points'] for r in worker_data['scores']),2)
            self.assertTrue(all(r['assignee']=='ZHC' for r in worker_data['scores']))
            self.assertEqual(owner_data['completed'],[])
            self.assertEqual(sum(r['points'] for r in owner_data['scores']),0)
            self.assertEqual(owner_data['member'],'YWH')
            self.assertEqual(owner_data['role'],'admin')
            self.assertTrue(owner_data['is_admin'])

        finally:
            server.shutdown();server.server_close();thread.join()
