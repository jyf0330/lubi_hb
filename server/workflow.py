"""Review points and owner-inserted priority; all writes share the board transaction."""
import math
import json
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

DEFAULT_REWORK_REASON = '时间不符需自述'


def points(value):
    if (
        type(value) not in (int, float)
        or not math.isfinite(value)
        or not float(value).is_integer()
        or not 0 <= value <= 10000
    ):
        raise ValueError('点数须为 0–10000 的整数，0 也算。')
    return int(value)


def migrate(db):
    columns = {r[1] for r in db.execute('PRAGMA table_info(tasks)')}
    for name, kind in [('owner_inserted', 'INTEGER NOT NULL DEFAULT 0'), ('awarded_points', 'REAL'), ('employee_ai_points', 'REAL'), ('employee_ai_reason', 'TEXT'), ('platform_ai_points', 'REAL'), ('platform_ai_reason', 'TEXT'), ('first_submitted_at', 'INTEGER')]:
        if name not in columns:
            db.execute(f'ALTER TABLE tasks ADD COLUMN {name} {kind}')
    # Keep the first review-submission date stable through rework/withdrawal.
    # Recover existing values from submission history when possible.
    db.execute(
        """UPDATE tasks SET first_submitted_at = COALESCE(
             (SELECT MIN(created_at) FROM task_events
              WHERE task_id = tasks.id AND event_type = '提交验收'),
             CASE WHEN status = '待验收' THEN submitted_at END
           ) WHERE first_submitted_at IS NULL"""
    )
    # Legacy priorities are not owner-authorized inserts; preserve their history.
    for row in db.execute("SELECT id, status, priority FROM tasks WHERE priority != '普通' AND owner_inserted = 0").fetchall():
        db.execute('INSERT INTO task_events (id,task_id,actor,event_type,from_status,to_status,detail,created_at) VALUES (?,?,?,?,?,?,?,?)',
                   (str(uuid.uuid4()), row[0], '系统迁移', '旧优先级归档', row[1], row[1], row[2], int(datetime.now().timestamp()*1000)))
    db.execute("UPDATE tasks SET priority='普通' WHERE owner_inserted=0")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_high_per_member ON tasks(assignee) WHERE priority='高'")


def apply(db, member, name, args, stamp, event, today):
    if name == 'owner_insert_task':
        if member != 'YWH':
            raise ValueError('只有负责人可以插入临时任务。')
        owner = args.get('assignee')
        title = str(args.get('title') or '').strip()
        if owner not in ('ZHC', 'YWT', 'YWH') or not 1 <= len(title) <= 120:
            raise ValueError('请选择员工并填写 1–120 字任务名称。')
        minutes = args.get('estimated_minutes', 120)
        if type(minutes) is not int or not 1 <= minutes <= 1440:
            raise ValueError('预期分钟须为 1–1440 的整数。')
        criteria = str(args.get('acceptance_criteria') or '').strip()
        if not criteria or len(criteria) > 800:
            raise ValueError('请填写不超过 800 字的验收要求。')
        task_id = str(uuid.uuid4())
        db.execute("INSERT INTO tasks(id,assignee,title,type,status,priority,planned_date,estimated_minutes,planned_points,acceptance_criteria,owner_inserted,created_at,updated_at) VALUES (?,?,?,'其他','今日待办','普通',?,?,0,?,1,?,?)", (task_id, owner, title, today, minutes, criteria, stamp, stamp))
        event(db, task_id, member, '负责人临时插单', None, '今日待办', '等待员工手动标高；通常两小时以内', stamp)
        return {'task_id': task_id, 'message': '临时任务已插入，等待员工标为高优先。'}
    if name == 'owner_review_group':
        # One-click acceptance for a whole big task. Only allowed once every
        # child has been submitted, so the owner is never asked to review a
        # big task piece by piece while work is still coming in.
        if member != 'YWH':
            raise ValueError('只有负责人可以审核打分。')
        group_id = str(args.get('group_id') or '').strip()
        group = db.execute('SELECT * FROM task_groups WHERE id=?', (group_id,)).fetchone()
        if not group:
            raise ValueError('找不到该大任务，请刷新后重试。')
        children = db.execute('SELECT * FROM tasks WHERE group_id=? ORDER BY group_order, created_at', (group_id,)).fetchall()
        if not children:
            raise ValueError('该大任务还没有小任务。')
        pending = [child for child in children if child['status'] == '待验收']
        if len(pending) != len(children):
            remaining = len(children) - len(pending)
            raise ValueError(f'大任务还有 {remaining} 个小任务未提交待验收，全部提交后才能一次验收。')
        reason = str(args.get('reason') or '').strip()
        if len(reason) > 1200:
            raise ValueError('审核说明最多 1200 字。')
        missing = [child['title'] for child in children if child['employee_ai_points'] is None]
        if missing:
            raise ValueError('以下小任务缺少员工自评分，不能一次验收：' + '、'.join(missing[:5]))
        acceptance = reason or '大任务整体验收通过'
        total = 0
        for child in children:
            score = points(child['employee_ai_points'])
            total += score
            changed = db.execute(
                "UPDATE tasks SET status='已完成',awarded_points=?,completed_at=?,acceptance_result=?,priority='普通',updated_at=? WHERE id=? AND status='待验收'",
                (score, stamp, acceptance, stamp, child['id']),
            ).rowcount
            if changed != 1:
                raise ValueError('任务已变化，请刷新后重试。')
            event(db, child['id'], member, '审核通过', '待验收', '已完成', json.dumps({'points': score, 'reason': acceptance, 'group_review': group['title']}, ensure_ascii=False), stamp)
        return {'message': f'已一次验收“{group["title"]}”的 {len(children)} 个小任务，合计 {total} 点。', 'group_id': group_id, 'points': total, 'accepted_count': len(children)}
    task = db.execute('SELECT * FROM tasks WHERE id=?', (str(args.get('task_id', '')),)).fetchone()
    if not task:
        raise ValueError('找不到该任务。')
    task_id, status = task['id'], task['status']
    if name == 'work_set_high_priority':
        if member != task['assignee'] or not task['owner_inserted'] or status in ('已完成', '待验收'):
            raise ValueError('只能把自己尚未提交的负责人临时插单标为高优先。')
        previous = db.execute("SELECT * FROM tasks WHERE assignee=? AND priority='高' AND id!=?", (member, task_id)).fetchall()
        for old in previous:
            db.execute("UPDATE tasks SET priority='普通',updated_at=? WHERE id=?", (stamp, old['id']))
            event(db, old['id'], member, '高优先被替换', old['status'], old['status'], '接替任务：'+task_id, stamp)
        db.execute("UPDATE tasks SET priority='高',updated_at=? WHERE id=?", (stamp, task_id))
        event(db, task_id, member, '手动标高', status, status, '其他任务执行状态保持，由员工自行调整', stamp)
        return {'message': '已设为唯一高优先任务，原高优先任务恢复正常。'}
    if name == 'work_unblock_task':
        if member != task['assignee'] or status != '阻塞':
            raise ValueError('只能解除自己的阻塞任务。')
        db.execute("UPDATE tasks SET status='今日待办',blocked_reason=NULL,updated_at=? WHERE id=?", (stamp, task_id))
        event(db, task_id, member, '解除阻塞', status, '今日待办', None, stamp)
        return {'message': '已解除阻塞，可自行开始。'}
    if name == 'work_withdraw_submission':
        if member != task['assignee']:
            raise ValueError('只能撤回自己的待验收任务。')
        if status != '待验收':
            raise ValueError('只有尚未处理的待验收任务可以撤回，请刷新。')
        # Keep the finished session in the time history. The employee must
        # explicitly resume before editing and submitting the work again.
        db.execute("UPDATE work_sessions SET ended_at=?, end_reason='撤回验收' WHERE task_id=? AND ended_at IS NULL", (stamp, task_id))
        changed = db.execute(
            """UPDATE tasks SET status='进行中', is_paused=1, result_summary=NULL,
               variance_reason=NULL, submitted_at=NULL, acceptance_result=NULL,
               awarded_points=NULL, completed_at=NULL, employee_ai_points=NULL,
               employee_ai_reason=NULL, platform_ai_points=NULL,
               platform_ai_reason=NULL, updated_at=?
               WHERE id=? AND assignee=? AND status='待验收'""",
            (stamp, task_id, member),
        ).rowcount
        if changed != 1:
            raise ValueError('任务已变化，请刷新后重试。')
        event(db, task_id, member, '员工撤回验收', status, '进行中', '已撤回待验收提交，任务暂停，等待员工重新开始并提交。', stamp)
        return {'message': '已取消待验收提交；任务已暂停，请点击“继续”后重写完成说明并重新提交。'}
    if name == 'owner_review_task':
        if member != 'YWH':
            raise ValueError('只有负责人可以审核打分。')
        if status != '待验收':
            raise ValueError('任务已处理或不在待验收状态，请刷新。')
        decision = args.get('decision')
        reason = str(args.get('reason') or '').strip()
        if decision == 'rework' and not reason:
            reason = DEFAULT_REWORK_REASON
        if decision not in ('accept', 'rework') or len(reason) > 1200 or (decision == 'rework' and not reason):
            raise ValueError('请选择审核结果；退回时须填写修改要求（最多 1200 字）。')
        if decision == 'accept':
            # The employee's self-score is the normal approval value. The
            # owner only supplies points when explicitly overriding it.
            submitted_score = args.get('points')
            if submitted_score is None:
                submitted_score = task['employee_ai_points']
            if submitted_score is None:
                raise ValueError('该任务缺少员工自评分，不能直接通过验收。')
            score = points(submitted_score)
        else:
            score = None
        target = '已完成' if decision == 'accept' else '需修改'
        db.execute("UPDATE tasks SET status=?,awarded_points=?,completed_at=?,acceptance_result=?,priority=CASE WHEN ?='已完成' THEN '普通' ELSE priority END,rework_count=rework_count+?,updated_at=? WHERE id=?", (target, score, stamp if score is not None else None, reason, target, int(decision=='rework'), stamp, task_id))
        event(db, task_id, member, '审核通过' if decision=='accept' else '退回修改', status, target, json.dumps({'points':score,'reason':reason}, ensure_ascii=False), stamp)
        return {'message': '已审核计分。' if decision=='accept' else '已退回；员工恢复工作后继续累计计时。'}
    raise ValueError('未知工作流操作。')


def daily_scores(db, report_date, days=7):
    end = datetime.strptime(report_date, '%Y-%m-%d').replace(tzinfo=ZoneInfo('Asia/Shanghai')) + timedelta(days=1)
    result = []
    for offset in range(days, 0, -1):
        start = end - timedelta(days=offset)
        stop = start + timedelta(days=1)
        for member in ('ZHC', 'YWT', 'YWH'):
            row = db.execute("SELECT COALESCE(SUM(awarded_points),0), COUNT(*), SUM(CASE WHEN awarded_points IS NULL THEN 1 ELSE 0 END) FROM tasks WHERE assignee=? AND status='已完成' AND completed_at>=? AND completed_at<?", (member, int(start.timestamp()*1000), int(stop.timestamp()*1000))).fetchone()
            result.append({'date':start.strftime('%Y-%m-%d'),'assignee':member,'points':round(row[0],2),'completed_count':row[1],'unscored_count':row[2] or 0})
    return result
