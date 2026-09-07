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

const people = [
  { id: 'ZHC', name: '赵浩丞', task: '西游主界面按钮图标', type: '美术', started: '09:12', elapsed: '1h 48m', planned: 6.5, done: 2.5, accent: 'cyan' },
  { id: 'YWT', name: '余文滔', task: '战斗流程回归测试', type: '测试', started: '10:05', elapsed: '55m', planned: 5, done: 2, accent: 'violet' },
] as const;

const columns = [
  { title: '今日待办', count: 2, tone: 'slate', tasks: [{ title: '商店价格表校对', owner: 'YWT', meta: '配置 · 1.5 点' }, { title: '活动页文案整理', owner: 'ZHC', meta: '文档 · 1 点' }] },
  { title: '进行中', count: 2, tone: 'cyan', tasks: [{ title: '西游主界面按钮图标', owner: 'ZHC', meta: '09:12 开始 · 1h 48m' }, { title: '战斗流程回归测试', owner: 'YWT', meta: '10:05 开始 · 55m' }] },
  { title: '待验收', count: 1, tone: 'amber', tasks: [{ title: '新手引导配置检查', owner: 'YWT', meta: '已提交 · 交付完整' }] },
  { title: '需修改', count: 1, tone: 'rose', tasks: [{ title: '背包空状态插图', owner: 'ZHC', meta: '返工 1 次 · 待重新提交' }] },
  { title: '已完成', count: 2, tone: 'green', tasks: [{ title: '角色技能资料归档', owner: 'ZHC', meta: '验收通过 · 1.5 点' }, { title: '登录异常复测', owner: 'YWT', meta: '验收通过 · 2 点' }] },
  { title: '阻塞', count: 1, tone: 'red', tasks: [{ title: '渠道包配置', owner: 'YWT', meta: '等待签名权限' }] },
] as const;

const timeline = [
  { time: '09:00', zhc: '角色技能资料归档', ywt: '登录异常复测', kind: 'done' },
  { time: '10:00', zhc: '主界面按钮图标', ywt: '战斗流程回归测试', kind: 'active' },
  { time: '11:00', zhc: '主界面按钮图标', ywt: '战斗流程回归测试', kind: 'active' },
] as const;

function Metric({ label, value, note, tone = 'neutral' }: { label: string; value: string; note: string; tone?: 'neutral' | 'good' | 'warn' }) {
  return <div className="metric-card"><div className="metric-label">{label}</div><div className={`metric-value metric-${tone}`}>{value}</div><div className="metric-note">{note}</div></div>;
}

export default function Home() {
  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="topbar">
        <div className="brand-mark"><Sparkles size={18} /></div>
        <div><h1>西游 · 生产作战室</h1><p>每日任务与交付状态</p></div>
        <nav className="topnav" aria-label="主导航">
          <a className="nav-active" href="#overview"><LayoutDashboard size={16} />总览</a><a href="#board"><ListChecks size={16} />任务</a><a href="#timeline"><Clock3 size={16} />时间轴</a><a href="#members"><Users size={16} />成员</a>
        </nav>
        <div className="date-chip">今天 · 9月8日 <ChevronDown size={14} /></div>
      </header>

      <div className="dashboard-shell" id="overview">
        <section className="summary-row" aria-label="今日摘要">
          <div className="status-brief"><div className="eyebrow"><Bot size={14} /> AI 今日简报</div><div className="brief-line"><span className="pulse-dot" />2 人正在执行任务，当前无新增阻塞</div><p>YWT 今日计划 5 点，低于建议负荷；有 1 项任务等待验收。</p></div>
          <Metric label="今日计划" value="11.5 点" note="建议总量 12–14 点" /><Metric label="已完成" value="4.5 点" note="完成率 39%" tone="good" /><Metric label="待验收" value="1 项" note="已等待 36 分钟" tone="warn" /><Metric label="阻塞" value="1 项" note="等待签名权限" tone="warn" />
        </section>

        <section className="section-block" id="members">
          <div className="section-heading"><div><span className="section-kicker">LIVE STATUS</span><h2>此刻谁在做什么</h2></div><div className="live-label"><span />实时更新</div></div>
          <div className="people-grid">
            {people.map((person) => {
              const remaining = person.planned - person.done;
              const pct = Math.round((person.done / person.planned) * 100);
              return <article className={`person-card accent-${person.accent}`} key={person.id}>
                <div className="person-main"><div className="avatar">{person.id}</div><div className="person-copy"><div className="person-name"><strong>{person.name}</strong><span>{person.id}</span></div><div className="working"><Play size={12} fill="currentColor" />进行中</div><h3>{person.task}</h3><p>{person.type} · {person.started} 开始</p></div><div className="elapsed"><span>持续</span><strong>{person.elapsed}</strong></div></div>
                <div className="workload"><div className="bar-copy"><span>今日完成 {person.done} / {person.planned} 点</span><span>剩余 {remaining} 点</span></div><div className="progress-track"><span style={{ width: `${pct}%` }} /></div></div>
                {person.planned < 6 && <div className="capacity-warning"><AlertTriangle size={14} />今日计划低于 6 点，建议补充任务</div>}
              </article>;
            })}
          </div>
        </section>

        <section className="section-block board-section" id="board">
          <div className="section-heading"><div><span className="section-kicker">TODAY BOARD</span><h2>今日任务看板</h2></div><div className="board-legend"><CircleDashed size={15} />共 9 项任务</div></div>
          <div className="kanban-scroll"><div className="kanban-grid">
            {columns.map((column) => <section className={`kanban-column tone-${column.tone}`} key={column.title}><header><span className="column-dot" /><h3>{column.title}</h3><b>{column.count}</b></header><div className="task-stack">{column.tasks.map((task) => <article className="task-card" key={task.title}><div className="task-owner">{task.owner}</div><h4>{task.title}</h4><p>{task.meta}</p></article>)}</div></section>)}
          </div></div>
        </section>

        <div className="lower-grid">
          <section className="section-block timeline-panel" id="timeline">
            <div className="section-heading compact"><div><span className="section-kicker">TIMELINE</span><h2>今日工作轨迹</h2></div><button className="text-action">查看完整时间轴 <ArrowRight size={14} /></button></div>
            <div className="timeline-head"><span>时间</span><span>ZHC · 赵浩丞</span><span>YWT · 余文滔</span></div>
            {timeline.map((row) => <div className="timeline-row" key={row.time}><time>{row.time}</time><div className={`timeline-task ${row.kind}`}><span />{row.zhc}</div><div className={`timeline-task ${row.kind}`}><span />{row.ywt}</div></div>)}
            <div className="timeline-footnote">未记录的时间只显示“未记录”，不作为考勤判断。</div>
          </section>
          <aside className="section-block review-panel">
            <div className="section-heading compact"><div><span className="section-kicker">REVIEW</span><h2>需要你处理</h2></div><span className="review-count">3</span></div>
            <div className="review-list"><div className="review-item"><ShieldCheck size={17} /><div><strong>新手引导配置检查</strong><span>YWT · 等待验收 36 分钟</span></div></div><div className="review-item"><RefreshCcw size={17} /><div><strong>背包空状态插图</strong><span>ZHC · 返工 1 次</span></div></div><div className="review-item"><TimerReset size={17} /><div><strong>渠道包配置</strong><span>YWT · 等待签名权限</span></div></div></div>
            <a className="primary-action" href="#board"><CheckCircle2 size={16} />查看待验收任务</a>
          </aside>
        </div>
      </div>
    </main>
  );
}
