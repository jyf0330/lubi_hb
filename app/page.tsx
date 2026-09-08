import { env } from 'cloudflare:workers';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  LayoutDashboard,
  ListChecks,
  Play,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Users,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

type TaskRow = {
  id: string;
  assignee: 'ZHC' | 'YWT';
  title: string;
  type: string;
  status: string;
  planned_points: number;
  blocked_reason: string | null;
  rework_count: number;
  submitted_at: number | null;
  completed_at: number | null;
  is_paused: number;
  updated_at: number;
};

type SessionRow = {
  assignee: 'ZHC' | 'YWT';
  title: string;
  started_at: number;
  ended_at: number | null;
};

type NowRow = { now_ms: number };

const memberMeta = {
  ZHC: { name: '赵浩丞', accent: 'cyan' },
  YWT: { name: '余文滔', accent: 'violet' },
} as const;

const statusColumns = [
  { title: '今日待办', tone: 'slate' },
  { title: '进行中', tone: 'cyan' },
  { title: '待验收', tone: 'amber' },
  { title: '需修改', tone: 'rose' },
  { title: '已完成', tone: 'green' },
  { title: '阻塞', tone: 'red' },
] as const;

function todayInShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function formatClock(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp));
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function taskMeta(task: TaskRow) {
  if (task.status === '阻塞') return task.blocked_reason || '等待解除阻塞';
  if (task.status === '需修改') return `返工 ${task.rework_count} 次 · 待重新提交`;
  if (task.status === '待验收') return `已提交 · ${task.submitted_at ? formatClock(task.submitted_at) : '等待检查'}`;
  if (task.status === '已完成') return `验收通过 · ${task.planned_points} 点`;
  return `${task.type} · ${task.planned_points} 点`;
}

function Metric({ label, value, note, tone = 'neutral' }: { label: string; value: string; note: string; tone?: 'neutral' | 'good' | 'warn' }) {
  return <div className="metric-card"><div className="metric-label">{label}</div><div className={`metric-value metric-${tone}`}>{value}</div><div className="metric-note">{note}</div></div>;
}

export default async function Home() {
  const today = todayInShanghai();
  const [taskResult, sessionResult, nowRow] = await Promise.all([
    env.DB.prepare(`SELECT id, assignee, title, type, status, planned_points, blocked_reason, rework_count, submitted_at, completed_at, is_paused, updated_at FROM tasks WHERE planned_date = ? ORDER BY updated_at DESC`).bind(today).all<TaskRow>(),
    env.DB.prepare(`SELECT ws.assignee, t.title, ws.started_at, ws.ended_at FROM work_sessions ws JOIN tasks t ON t.id = ws.task_id WHERE t.planned_date = ? ORDER BY ws.started_at DESC LIMIT 12`).bind(today).all<SessionRow>(),
    env.DB.prepare(`SELECT CAST(unixepoch('now') * 1000 AS INTEGER) AS now_ms`).first<NowRow>(),
  ]);
  const tasks = taskResult.results;
  const sessions = sessionResult.results;
  const now = Number(nowRow?.now_ms ?? 0);
  const people = (['ZHC', 'YWT'] as const).map((id) => {
    const ownTasks = tasks.filter((task) => task.assignee === id);
    const activeTask = ownTasks.find((task) => task.status === '进行中');
    const activeSession = activeTask ? sessions.find((session) => session.assignee === id && session.title === activeTask.title && session.ended_at === null) : undefined;
    const planned = ownTasks.reduce((sum, task) => sum + Number(task.planned_points), 0);
    const done = ownTasks.filter((task) => task.status === '已完成').reduce((sum, task) => sum + Number(task.planned_points), 0);
    return {
      id,
      ...memberMeta[id],
      task: activeTask?.title ?? '当前没有进行中的任务',
      type: activeTask?.type ?? '未记录',
      started: activeSession ? formatClock(activeSession.started_at) : null,
      elapsed: activeSession ? formatDuration(Math.max(0, Math.floor((now - activeSession.started_at) / 60000))) : null,
      paused: Boolean(activeTask?.is_paused),
      planned,
      done,
    };
  });
  const plannedTotal = people.reduce((sum, person) => sum + person.planned, 0);
  const doneTotal = people.reduce((sum, person) => sum + person.done, 0);
  const waiting = tasks.filter((task) => task.status === '待验收');
  const blocked = tasks.filter((task) => task.status === '阻塞');
  const activeCount = people.filter((person) => person.started && !person.paused).length;
  const lowCapacity = people.filter((person) => person.planned < 6).map((person) => person.id);
  const reviewTasks = tasks.filter((task) => ['待验收', '需修改', '阻塞'].includes(task.status)).slice(0, 5);
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(new Date());

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="topbar">
        <div className="brand-mark"><Sparkles size={18} /></div>
        <div><h1>西游团队生产看板</h1><p>每日任务与交付状态</p></div>
        <nav className="topnav" aria-label="主导航">
          <a className="nav-active" href="#overview"><LayoutDashboard size={16} />总览</a><a href="#board"><ListChecks size={16} />任务</a><a href="#timeline"><Clock3 size={16} />时间轴</a><a href="#members"><Users size={16} />成员</a>
        </nav>
        <div className="date-chip">今天 · {dateLabel} <ChevronDown size={14} /></div>
      </header>

      <div className="dashboard-shell" id="overview">
        <section className="summary-row" aria-label="今日摘要">
          <div className="status-brief"><div className="eyebrow"><Bot size={14} /> AI 今日简报</div><div className="brief-line"><span className="pulse-dot" />{activeCount} 人正在执行任务，{blocked.length ? `${blocked.length} 项阻塞` : '当前无阻塞'}</div><p>{lowCapacity.length ? `${lowCapacity.join('、')} 今日计划低于 6 点；` : '两人计划工作量均达到 6 点；'}有 {waiting.length} 项任务等待验收。</p></div>
          <Metric label="今日计划" value={`${plannedTotal} 点`} note="建议总量 12–14 点" /><Metric label="已完成" value={`${doneTotal} 点`} note={`完成率 ${plannedTotal ? Math.round((doneTotal / plannedTotal) * 100) : 0}%`} tone="good" /><Metric label="待验收" value={`${waiting.length} 项`} note={waiting.length ? '请及时检查交付结果' : '当前无需处理'} tone={waiting.length ? 'warn' : 'neutral'} /><Metric label="阻塞" value={`${blocked.length} 项`} note={blocked[0]?.blocked_reason || '当前无阻塞'} tone={blocked.length ? 'warn' : 'neutral'} />
        </section>

        <section className="section-block" id="members">
          <div className="section-heading"><div><span className="section-kicker">LIVE STATUS</span><h2>此刻谁在做什么</h2></div><div className="live-label"><span />读取服务器记录</div></div>
          <div className="people-grid">
            {people.map((person) => {
              const remaining = Math.max(0, person.planned - person.done);
              const pct = person.planned ? Math.min(100, Math.round((person.done / person.planned) * 100)) : 0;
              return <article className={`person-card accent-${person.accent}`} key={person.id}>
                <div className="person-main"><div className="avatar">{person.id}</div><div className="person-copy"><div className="person-name"><strong>{person.name}</strong><span>{person.id}</span></div><div className="working"><Play size={12} fill="currentColor" />{person.started ? (person.paused ? '已暂停' : '进行中') : '未记录'}</div><h3>{person.task}</h3><p>{person.started ? `${person.type} · ${person.started} 开始` : '等待员工从 work 对话开始任务'}</p></div><div className="elapsed"><span>{person.started ? '持续' : '记录'}</span><strong>{person.elapsed ?? '—'}</strong></div></div>
                <div className="workload"><div className="bar-copy"><span>今日完成 {person.done} / {person.planned} 点</span><span>剩余 {remaining} 点</span></div><div className="progress-track"><span style={{ width: `${pct}%` }} /></div></div>
                {person.planned < 6 && <div className="capacity-warning"><AlertTriangle size={14} />今日计划低于 6 点，建议补充任务</div>}
              </article>;
            })}
          </div>
        </section>

        <section className="section-block board-section" id="board">
          <div className="section-heading"><div><span className="section-kicker">TODAY BOARD</span><h2>今日任务看板</h2></div><div className="board-legend"><CircleDashed size={15} />共 {tasks.length} 项任务</div></div>
          <div className="kanban-scroll"><div className="kanban-grid">
            {statusColumns.map((column) => {
              const columnTasks = tasks.filter((task) => task.status === column.title);
              return <section className={`kanban-column tone-${column.tone}`} key={column.title}><header><span className="column-dot" /><h3>{column.title}</h3><b>{columnTasks.length}</b></header><div className="task-stack">{columnTasks.length ? columnTasks.map((task) => <article className="task-card" key={task.id}><div className="task-owner">{task.assignee}</div><h4>{task.title}</h4><p>{taskMeta(task)}</p></article>) : <article className="task-card"><h4>暂无任务</h4><p>员工更新后自动显示</p></article>}</div></section>;
            })}
          </div></div>
        </section>

        <div className="lower-grid">
          <section className="section-block timeline-panel" id="timeline">
            <div className="section-heading compact"><div><span className="section-kicker">TIMELINE</span><h2>今日工作轨迹</h2></div><span className="text-action">最近 {sessions.length} 条记录 <ArrowRight size={14} /></span></div>
            <div className="timeline-head"><span>时间</span><span>ZHC · 赵浩丞</span><span>YWT · 余文滔</span></div>
            {sessions.length ? sessions.map((session, index) => <div className="timeline-row" key={`${session.assignee}-${session.started_at}-${index}`}><time>{formatClock(session.started_at)}</time><div className={`timeline-task ${session.assignee === 'ZHC' ? (session.ended_at ? 'done' : 'active') : ''}`}><span />{session.assignee === 'ZHC' ? session.title : '未记录'}</div><div className={`timeline-task ${session.assignee === 'YWT' ? (session.ended_at ? 'done' : 'active') : ''}`}><span />{session.assignee === 'YWT' ? session.title : '未记录'}</div></div>) : <div className="timeline-row"><time>—</time><div className="timeline-task"><span />未记录</div><div className="timeline-task"><span />未记录</div></div>}
            <div className="timeline-footnote">未记录的时间只显示“未记录”，不作为考勤判断。</div>
          </section>
          <aside className="section-block review-panel">
            <div className="section-heading compact"><div><span className="section-kicker">REVIEW</span><h2>需要你处理</h2></div><span className="review-count">{reviewTasks.length}</span></div>
            <div className="review-list">{reviewTasks.length ? reviewTasks.map((task) => <div className="review-item" key={task.id}>{task.status === '待验收' ? <ShieldCheck size={17} /> : task.status === '需修改' ? <RefreshCcw size={17} /> : <TimerReset size={17} />}<div><strong>{task.title}</strong><span>{task.assignee} · {taskMeta(task)}</span></div></div>) : <div className="review-item"><CheckCircle2 size={17} /><div><strong>当前无需处理</strong><span>待验收、返工和阻塞会显示在这里</span></div></div>}</div>
            <a className="primary-action" href="#board"><CheckCircle2 size={16} />查看任务看板</a>
          </aside>
        </div>
      </div>
    </main>
  );
}
