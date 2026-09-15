'use client';

import { useEffect, useState, type SyntheticEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  FileUp,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  encodeImageDrafts,
  PasteImageField,
  releaseImageDrafts,
  type PastedImageDraft,
} from '@/components/paste-image-field';
import {
  encodeFileDrafts,
  FileAttachmentField,
  type FileAttachmentDraft,
} from '@/components/file-attachment-field';
import { PomodoroTimer } from '@/components/pomodoro-timer';
import type { SessionRow, TaskAttachmentRow, TaskRow } from '@/lib/task-data';
import {
  MEMBERS,
  TASK_TYPES,
  plannedPoints,
  type Member,
  type TaskAction,
  type TaskType,
} from '@/lib/task-domain';

const memberMeta = {
  ZHC: { name: '赵浩丞', accent: 'cyan' },
  YWT: { name: '余文滔', accent: 'violet' },
} as const;

const statusColumns = [
  { title: '任务池', tone: 'slate' },
  { title: '今日待办', tone: 'slate' },
  { title: '进行中', tone: 'cyan' },
  { title: '待验收', tone: 'amber' },
  { title: '需修改', tone: 'rose' },
  { title: '已完成', tone: 'green' },
  { title: '阻塞', tone: 'red' },
] as const;

type CreateDraft = {
  title: string;
  assignee: Member | 'UNASSIGNED';
  type: TaskType;
  priority: '低' | '普通' | '高' | '紧急';
  estimatedMinutes: number;
  deliverableExpectation: string;
  acceptanceCriteria: string;
  notes: string;
  artProgressUrl: string;
  artFinalUrl: string;
  artSourceUrl: string;
  testPlannedCases: number;
  testActualCases: number;
  testNewBugs: number;
  testValidBugs: number;
  testRegressionBugs: number;
  testSevereBugs: number;
};

const emptyDraft: CreateDraft = {
  title: '',
  assignee: 'UNASSIGNED',
  type: '其他',
  priority: '普通',
  estimatedMinutes: 60,
  deliverableExpectation: '',
  acceptanceCriteria: '',
  notes: '',
  artProgressUrl: '',
  artFinalUrl: '',
  artSourceUrl: '',
  testPlannedCases: 0,
  testActualCases: 0,
  testNewBugs: 0,
  testValidBugs: 0,
  testRegressionBugs: 0,
  testSevereBugs: 0,
};

const actionCopy: Record<
  TaskAction,
  { label: string; detail?: string; placeholder?: string }
> = {
  claim: { label: '领取' },
  start: { label: '开始' },
  pause: { label: '暂停' },
  resume: { label: '继续' },
  submit: {
    label: '提交待验收',
    detail: '完成说明',
    placeholder: '说明完成内容、结果与需要验收的重点',
  },
  accept: {
    label: '验收通过',
    detail: '验收结论',
    placeholder: '可选：记录验收结论',
  },
  rework: {
    label: '退回修改',
    detail: '修改要求',
    placeholder: '明确需要修改的内容',
  },
  block: {
    label: '标记阻塞',
    detail: '阻塞原因',
    placeholder: '说明阻塞原因和需要谁协助',
  },
  unblock: { label: '解除阻塞' },
};

function formatClock(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function formatAttachmentSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function taskMeta(task: TaskRow) {
  if (task.status === '任务池')
    return `${task.type} · ${task.planned_points} 点 · 待领取`;
  if (task.status === '阻塞') return task.blocked_reason || '等待解除阻塞';
  if (task.status === '需修改')
    return `返工 ${task.rework_count} 次 · 待重新开始`;
  if (task.status === '待验收')
    return `已提交 · ${task.submitted_at ? formatClock(task.submitted_at) : '等待检查'}`;
  if (task.status === '已完成') return `验收通过 · ${task.planned_points} 点`;
  if (task.status === '进行中' && task.is_paused) return '已暂停 · 可继续';
  return `${task.type} · ${task.planned_points} 点`;
}

function actionsFor(task: TaskRow): TaskAction[] {
  if (task.status === '任务池') return ['claim'];
  if (task.status === '今日待办' || task.status === '需修改')
    return ['start', 'block'];
  if (task.status === '进行中')
    return task.is_paused
      ? ['resume', 'submit', 'block']
      : ['pause', 'submit', 'block'];
  if (task.status === '待验收') return ['accept', 'rework'];
  if (task.status === '阻塞') return ['unblock'];
  return [];
}

function Metric({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  note: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className={`metric-value metric-${tone}`}>{value}</div>
      <div className="metric-note">{note}</div>
    </div>
  );
}

export function TaskDashboard({
  tasks,
  sessions,
  now,
  today,
}: {
  tasks: TaskRow[];
  sessions: SessionRow[];
  now: number;
  today: string;
}) {
  const router = useRouter();
  const [actor, setActor] = useState<Member>('ZHC');
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(emptyDraft);
  const [selectedTask, setSelectedTask] = useState<TaskRow | null>(null);
  const [pendingAction, setPendingAction] = useState<TaskAction | null>(null);
  const [detail, setDetail] = useState('');
  const [deliverableUrl, setDeliverableUrl] = useState('');
  const [draftImages, setDraftImages] = useState<PastedImageDraft[]>([]);
  const [draftFiles, setDraftFiles] = useState<FileAttachmentDraft[]>([]);
  const [actionImages, setActionImages] = useState<PastedImageDraft[]>([]);
  const [actionFiles, setActionFiles] = useState<FileAttachmentDraft[]>([]);
  const [taskAttachments, setTaskAttachments] = useState<TaskAttachmentRow[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    kind: 'ok' | 'error';
    text: string;
  } | null>(null);
  const selectedTaskId = selectedTask?.id;

  function openTask(task: TaskRow) {
    setTaskAttachments([]);
    setSelectedTask(task);
  }

  useEffect(() => {
    if (!selectedTaskId || pendingAction) return;
    let cancelled = false;
    void fetch(`/api/tasks/${selectedTaskId}/attachments`)
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as {
          ok: boolean;
          attachments?: TaskAttachmentRow[];
        };
      })
      .then((body) => {
        if (!cancelled && body?.ok) setTaskAttachments(body.attachments ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pendingAction, selectedTaskId]);

  const todayTasks = tasks.filter((task) => task.planned_date === today);
  const people = MEMBERS.map((id) => {
    const ownTasks = todayTasks.filter((task) => task.assignee === id);
    const activeTask = ownTasks.find((task) => task.status === '进行中');
    const activeSession = activeTask
      ? sessions.find(
          (session) =>
            session.assignee === id &&
            session.title === activeTask.title &&
            session.ended_at === null,
        )
      : undefined;
    const planned = ownTasks.reduce(
      (sum, task) => sum + Number(task.planned_points),
      0,
    );
    const done = ownTasks
      .filter((task) => task.status === '已完成')
      .reduce((sum, task) => sum + Number(task.planned_points), 0);
    return {
      id,
      ...memberMeta[id],
      task: activeTask?.title ?? '当前没有进行中的任务',
      type: activeTask?.type ?? '未记录',
      started: activeSession ? formatClock(activeSession.started_at) : null,
      elapsed: activeSession
        ? formatDuration(
            Math.max(0, Math.floor((now - activeSession.started_at) / 60000)),
          )
        : null,
      paused: Boolean(activeTask?.is_paused),
      planned,
      done,
      remaining: Math.max(0, planned - done),
    };
  });
  const plannedTotal = people.reduce((sum, person) => sum + person.planned, 0);
  const doneTotal = people.reduce((sum, person) => sum + person.done, 0);
  const waiting = todayTasks.filter((task) => task.status === '待验收');
  const blocked = todayTasks.filter((task) => task.status === '阻塞');
  const activeCount = people.filter(
    (person) => person.started && !person.paused,
  ).length;
  const dateLabel = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${today}T12:00:00+08:00`));

  async function readResponse(response: Response) {
    const body = (await response.json()) as {
      ok: boolean;
      message?: string;
      error?: string;
    };
    if (!response.ok || !body.ok) throw new Error(body.error || '操作失败。');
    return body;
  }

  async function createTask(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const images = await encodeImageDrafts(draftImages);
      const files = await encodeFileDrafts(draftFiles);
      await readResponse(
        await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...draft,
            actor,
            assignee: draft.assignee === 'UNASSIGNED' ? null : draft.assignee,
            images,
            files,
          }),
        }),
      );
      releaseImageDrafts(draftImages);
      setDraftImages([]);
      setDraftFiles([]);
      setDraft(emptyDraft);
      setCreateOpen(false);
      setNotice({ kind: 'ok', text: '任务已创建并保存。' });
      router.refresh();
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : '创建失败。',
      });
    } finally {
      setBusy(false);
    }
  }

  async function runAction(
    action: TaskAction,
    task: TaskRow,
    withDetail = false,
  ) {
    if (withDetail) {
      setSelectedTask(task);
      setPendingAction(action);
      setDetail('');
      setDeliverableUrl('');
      releaseImageDrafts(actionImages);
      setActionImages([]);
      setActionFiles([]);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const body = await readResponse(
        await fetch(`/api/tasks/${task.id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, actor }),
        }),
      );
      setSelectedTask(null);
      setNotice({ kind: 'ok', text: body.message || '操作成功。' });
      router.refresh();
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : '操作失败。',
      });
    } finally {
      setBusy(false);
    }
  }

  async function submitDetailedAction(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingAction || !selectedTask) return;
    setBusy(true);
    setNotice(null);
    try {
      const images = await encodeImageDrafts(actionImages);
      const files = await encodeFileDrafts(actionFiles);
      const body = await readResponse(
        await fetch(`/api/tasks/${selectedTask.id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: pendingAction,
            actor,
            detail,
            deliverableUrl,
            images,
            files,
          }),
        }),
      );
      releaseImageDrafts(actionImages);
      setActionImages([]);
      setActionFiles([]);
      setPendingAction(null);
      setSelectedTask(null);
      setNotice({ kind: 'ok', text: body.message || '操作成功。' });
      router.refresh();
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : '操作失败。',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="topbar">
        <div className="brand-mark">
          <Sparkles size={18} />
        </div>
        <div>
          <h1>西游团队生产看板</h1>
          <p>每日任务与交付状态</p>
        </div>
        <nav className="topnav" aria-label="主导航">
          <a className="nav-active" href="#overview">
            <LayoutDashboard size={16} />
            总览
          </a>
          <a href="#board">
            <ListChecks size={16} />
            任务
          </a>
          <a href="#timeline">
            <Clock3 size={16} />
            时间轴
          </a>
          <a href="#members">
            <Users size={16} />
            成员
          </a>
        </nav>
        <div className="operator-picker" aria-label="当前操作者">
          <span>操作者</span>
          {MEMBERS.map((member) => (
            <button
              className={actor === member ? 'active' : ''}
              key={member}
              onClick={() => setActor(member)}
              type="button"
            >
              {member}
            </button>
          ))}
        </div>
        <div className="date-chip">
          今天 · {dateLabel} <ChevronDown size={14} />
        </div>
      </header>

      <div className="dashboard-shell" id="overview">
        {notice && (
          <output className={`notice notice-${notice.kind}`}>
            {notice.text}
          </output>
        )}
        <PomodoroTimer actor={actor} tasks={tasks} />
        <section className="summary-row" aria-label="今日摘要">
          <div className="status-brief">
            <div className="eyebrow">
              <Bot size={14} />
              今日概况
            </div>
            <div className="brief-line">
              <span className="pulse-dot" />
              {activeCount} 人正在执行，
              {blocked.length ? `${blocked.length} 项阻塞` : '当前无阻塞'}
            </div>
            <p>
              任务池 {tasks.filter((task) => task.status === '任务池').length}{' '}
              项，待验收 {waiting.length} 项。
            </p>
          </div>
          <Metric
            label="今日计划"
            value={`${plannedTotal} 点`}
            note="领取或指派后计入"
          />
          <Metric
            label="已完成"
            value={`${doneTotal} 点`}
            note={`完成率 ${plannedTotal ? Math.round((doneTotal / plannedTotal) * 100) : 0}%`}
            tone="good"
          />
          <Metric
            label="剩余"
            value={`${Math.max(0, plannedTotal - doneTotal)} 点`}
            note="计划减去验收完成"
            tone="warn"
          />
          <Metric
            label="待验收"
            value={`${waiting.length} 项`}
            note={waiting.length ? '请及时检查交付结果' : '当前无需处理'}
          />
        </section>

        <section className="section-block" id="members">
          <div className="section-heading">
            <div>
              <span className="section-kicker">TEAM TODAY</span>
              <h2>两人今日点数</h2>
            </div>
            <div className="live-label">
              <span />
              SQLite 实时记录
            </div>
          </div>
          <div className="people-grid">
            {people.map((person) => {
              const pct = person.planned
                ? Math.min(
                    100,
                    Math.round((person.done / person.planned) * 100),
                  )
                : 0;
              return (
                <article
                  className={`person-card accent-${person.accent}`}
                  key={person.id}
                >
                  <div className="person-main">
                    <div className="avatar">{person.id}</div>
                    <div className="person-copy">
                      <div className="person-name">
                        <strong>{person.name}</strong>
                        <span>{person.id}</span>
                      </div>
                      <div className="working">
                        {person.paused ? (
                          <Pause size={12} />
                        ) : (
                          <Play size={12} fill="currentColor" />
                        )}
                        {person.paused
                          ? '已暂停'
                          : person.started
                            ? '进行中'
                            : '未进行'}
                      </div>
                      <h3>{person.task}</h3>
                      <p>
                        {person.started
                          ? `${person.type} · ${person.started} 开始`
                          : '可从今日待办开始任务'}
                      </p>
                    </div>
                    <div className="elapsed">
                      <span>{person.started ? '本段持续' : '计时'}</span>
                      <strong>{person.elapsed ?? '—'}</strong>
                    </div>
                  </div>
                  <div className="point-strip">
                    <span>
                      <b>{person.planned}</b>计划
                    </span>
                    <span>
                      <b>{person.done}</b>完成
                    </span>
                    <span>
                      <b>{person.remaining}</b>剩余
                    </span>
                  </div>
                  <div className="workload">
                    <div className="progress-track">
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  {person.planned < 6 && (
                    <div className="capacity-warning">
                      <AlertTriangle size={14} />
                      今日计划低于 6 点
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="section-block board-section" id="board">
          <div className="section-heading">
            <div>
              <span className="section-kicker">DAILY WORKFLOW</span>
              <h2>任务看板</h2>
            </div>
            <Button
              className="create-button"
              onClick={() => setCreateOpen(true)}
            >
              <Plus />
              创建任务
            </Button>
          </div>
          <div className="kanban-scroll">
            <div className="kanban-grid">
              {statusColumns.map((column) => {
                const columnTasks = tasks.filter(
                  (task) => task.status === column.title,
                );
                return (
                  <section
                    className={`kanban-column tone-${column.tone}`}
                    key={column.title}
                  >
                    <header>
                      <span className="column-dot" />
                      <h3>{column.title}</h3>
                      <b>{columnTasks.length}</b>
                    </header>
                    <div className="task-stack">
                      {columnTasks.length ? (
                        columnTasks.map((task) => (
                          <button
                            className="task-card"
                            key={task.id}
                            onClick={() => openTask(task)}
                            type="button"
                          >
                            <div className="task-owner">
                              {task.assignee ?? '待领'}
                            </div>
                            <h4>{task.title}</h4>
                            <p>{taskMeta(task)}</p>
                          </button>
                        ))
                      ) : (
                        <div className="empty-column">
                          <CircleDashed size={16} />
                          暂无任务
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </section>

        <div className="lower-grid">
          <section className="section-block timeline-panel" id="timeline">
            <div className="section-heading compact">
              <div>
                <span className="section-kicker">TIMELINE</span>
                <h2>今日工作轨迹</h2>
              </div>
              <span className="board-legend">最近 {sessions.length} 条</span>
            </div>
            <div className="timeline-head">
              <span>时间</span>
              <span>ZHC · 赵浩丞</span>
              <span>YWT · 余文滔</span>
            </div>
            {sessions.length ? (
              sessions.map((session, index) => (
                <div
                  className="timeline-row"
                  key={`${session.assignee}-${session.started_at}-${index}`}
                >
                  <time>{formatClock(session.started_at)}</time>
                  <div
                    className={`timeline-task ${session.assignee === 'ZHC' ? (session.ended_at ? 'done' : 'active') : ''}`}
                  >
                    <span />
                    {session.assignee === 'ZHC' ? session.title : '—'}
                  </div>
                  <div
                    className={`timeline-task ${session.assignee === 'YWT' ? (session.ended_at ? 'done' : 'active') : ''}`}
                  >
                    <span />
                    {session.assignee === 'YWT' ? session.title : '—'}
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-timeline">今天还没有计时记录。</div>
            )}
          </section>
          <aside className="section-block review-panel">
            <div className="section-heading compact">
              <div>
                <span className="section-kicker">REVIEW</span>
                <h2>需要处理</h2>
              </div>
              <span className="review-count">
                {waiting.length + blocked.length}
              </span>
            </div>
            <div className="review-list">
              {[...waiting, ...blocked].slice(0, 6).map((task) => (
                <button
                  className="review-item"
                  key={task.id}
                  onClick={() => openTask(task)}
                  type="button"
                >
                  {task.status === '待验收' ? (
                    <ShieldCheck size={17} />
                  ) : (
                    <TimerReset size={17} />
                  )}
                  <div>
                    <strong>{task.title}</strong>
                    <span>
                      {task.assignee} · {taskMeta(task)}
                    </span>
                  </div>
                </button>
              ))}
              {!waiting.length && !blocked.length && (
                <div className="review-item">
                  <CheckCircle2 size={17} />
                  <div>
                    <strong>当前无需处理</strong>
                    <span>待验收和阻塞任务会显示在这里</span>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            releaseImageDrafts(draftImages);
            setDraftImages([]);
            setDraftFiles([]);
          }
        }}
      >
        <DialogContent className="task-dialog max-w-2xl">
          <form onSubmit={createTask}>
            <DialogHeader>
              <DialogTitle>创建任务</DialogTitle>
              <DialogDescription>
                不指定负责人时进入任务池；指定后直接计入其今日计划。
              </DialogDescription>
            </DialogHeader>
            <div className="form-grid">
              <label className="field field-wide" htmlFor="task-title">
                <span>任务标题</span>
                <Input
                  id="task-title"
                  required
                  minLength={2}
                  value={draft.title}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                />
              </label>
              <label className="field" htmlFor="task-assignee">
                <span>负责人</span>
                <Select
                  value={draft.assignee}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      assignee: value as CreateDraft['assignee'],
                    })
                  }
                >
                  <SelectTrigger id="task-assignee">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UNASSIGNED">暂不指派</SelectItem>
                    <SelectItem value="ZHC">ZHC · 赵浩丞</SelectItem>
                    <SelectItem value="YWT">YWT · 余文滔</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="field" htmlFor="task-type">
                <span>类型</span>
                <Select
                  value={draft.type}
                  onValueChange={(value) =>
                    setDraft({ ...draft, type: value as TaskType })
                  }
                >
                  <SelectTrigger id="task-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_TYPES.map((type) => (
                      <SelectItem value={type} key={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="field" htmlFor="task-priority">
                <span>优先级</span>
                <Select
                  value={draft.priority}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      priority: value as CreateDraft['priority'],
                    })
                  }
                >
                  <SelectTrigger id="task-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['低', '普通', '高', '紧急'].map((priority) => (
                      <SelectItem value={priority} key={priority}>
                        {priority}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="field" htmlFor="task-estimate">
                <span>
                  预计分钟 · {plannedPoints(draft.estimatedMinutes)} 点
                </span>
                <Input
                  id="task-estimate"
                  type="number"
                  min={15}
                  max={1440}
                  step={15}
                  value={draft.estimatedMinutes}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      estimatedMinutes: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label className="field field-wide" htmlFor="task-deliverable">
                <span>交付预期</span>
                <Textarea
                  id="task-deliverable"
                  value={draft.deliverableExpectation}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      deliverableExpectation: event.target.value,
                    })
                  }
                  placeholder="要交付什么"
                />
              </label>
              <label className="field field-wide" htmlFor="task-acceptance">
                <span>验收标准</span>
                <Textarea
                  id="task-acceptance"
                  value={draft.acceptanceCriteria}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      acceptanceCriteria: event.target.value,
                    })
                  }
                  placeholder="怎样才算完成"
                />
              </label>
              {draft.type === '美术' && (
                <>
                  <label
                    className="field field-wide specialty"
                    htmlFor="task-art-progress"
                  >
                    <span>过程图链接</span>
                    <Input
                      id="task-art-progress"
                      type="url"
                      value={draft.artProgressUrl}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          artProgressUrl: event.target.value,
                        })
                      }
                      placeholder="https://"
                    />
                  </label>
                  <label
                    className="field field-wide specialty"
                    htmlFor="task-art-final"
                  >
                    <span>最终稿链接</span>
                    <Input
                      id="task-art-final"
                      type="url"
                      value={draft.artFinalUrl}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          artFinalUrl: event.target.value,
                        })
                      }
                      placeholder="https://"
                    />
                  </label>
                  <label
                    className="field field-wide specialty"
                    htmlFor="task-art-source"
                  >
                    <span>源文件链接</span>
                    <Input
                      id="task-art-source"
                      type="url"
                      value={draft.artSourceUrl}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          artSourceUrl: event.target.value,
                        })
                      }
                      placeholder="https://"
                    />
                  </label>
                </>
              )}
              {draft.type === '测试' && (
                <div className="field-wide specialty specialty-grid">
                  <label className="field" htmlFor="task-test-planned-cases">
                    <span>计划 Case 数</span>
                    <Input
                      id="task-test-planned-cases"
                      type="number"
                      min={0}
                      value={draft.testPlannedCases}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          testPlannedCases: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field" htmlFor="task-test-actual-cases">
                    <span>实际 Case 数</span>
                    <Input
                      id="task-test-actual-cases"
                      type="number"
                      min={0}
                      value={draft.testActualCases}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          testActualCases: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field" htmlFor="task-test-new-bugs">
                    <span>新 BUG 数</span>
                    <Input
                      id="task-test-new-bugs"
                      type="number"
                      min={0}
                      value={draft.testNewBugs}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          testNewBugs: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field" htmlFor="task-test-valid-bugs">
                    <span>有效 BUG 数</span>
                    <Input
                      id="task-test-valid-bugs"
                      type="number"
                      min={0}
                      value={draft.testValidBugs}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          testValidBugs: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field" htmlFor="task-test-regression-bugs">
                    <span>回归 BUG 数</span>
                    <Input
                      id="task-test-regression-bugs"
                      type="number"
                      min={0}
                      value={draft.testRegressionBugs}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          testRegressionBugs: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field" htmlFor="task-test-severe-bugs">
                    <span>严重 BUG 数</span>
                    <Input
                      id="task-test-severe-bugs"
                      type="number"
                      min={0}
                      value={draft.testSevereBugs}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          testSevereBugs: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                </div>
              )}
              <div className="field field-wide">
                <span>备注与附件</span>
                <PasteImageField
                  id="task-notes"
                  value={draft.notes}
                  images={draftImages}
                  onImagesChange={setDraftImages}
                  onChange={(event) =>
                    setDraft({ ...draft, notes: event.target.value })
                  }
                />
                <FileAttachmentField
                  files={draftFiles}
                  onFilesChange={setDraftFiles}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  releaseImageDrafts(draftImages);
                  setDraftImages([]);
                  setDraftFiles([]);
                  setCreateOpen(false);
                }}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <LoaderCircle className="spin" />}创建并保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(selectedTask) && !pendingAction}
        onOpenChange={(open) => !open && setSelectedTask(null)}
      >
        <DialogContent className="task-dialog review-dialog max-w-xl">
          {selectedTask && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedTask.title}</DialogTitle>
                <DialogDescription>
                  {selectedTask.status} · {selectedTask.type} ·{' '}
                  {selectedTask.planned_points} 点 · 负责人{' '}
                  {selectedTask.assignee ?? '未领取'}
                </DialogDescription>
              </DialogHeader>
              <div className="detail-list">
                <div>
                  <span>交付预期</span>
                  <p>{selectedTask.deliverable_expectation || '未填写'}</p>
                </div>
                <div>
                  <span>验收标准</span>
                  <p>{selectedTask.acceptance_criteria || '未填写'}</p>
                </div>
                {selectedTask.type === '美术' && (
                  <>
                    <div className="specialty">
                      <span>过程图</span>
                      <p>{selectedTask.art_progress_url || '未填写'}</p>
                    </div>
                    <div className="specialty">
                      <span>最终稿</span>
                      <p>{selectedTask.art_final_url || '未填写'}</p>
                    </div>
                    <div className="specialty">
                      <span>源文件</span>
                      <p>{selectedTask.art_source_url || '未填写'}</p>
                    </div>
                  </>
                )}
                {selectedTask.type === '测试' && (
                  <>
                    <div className="specialty">
                      <span>Case 统计</span>
                      <p>
                        计划 {selectedTask.test_planned_cases ?? 0} · 实际{' '}
                        {selectedTask.test_actual_cases ?? 0}
                      </p>
                    </div>
                    <div className="specialty">
                      <span>BUG 统计</span>
                      <p>
                        新增 {selectedTask.test_new_bugs ?? 0} · 有效{' '}
                        {selectedTask.test_valid_bugs ?? 0} · 回归{' '}
                        {selectedTask.test_regression_bugs ?? 0} · 严重{' '}
                        {selectedTask.test_severe_bugs ?? 0}
                      </p>
                    </div>
                  </>
                )}
                {selectedTask.result_summary && (
                  <div>
                    <span>完成说明</span>
                    <p>{selectedTask.result_summary}</p>
                  </div>
                )}
                {selectedTask.acceptance_result && (
                  <div>
                    <span>验收记录</span>
                    <p>{selectedTask.acceptance_result}</p>
                  </div>
                )}
                {selectedTask.blocked_reason && (
                  <div className="danger-detail">
                    <span>阻塞原因</span>
                    <p>{selectedTask.blocked_reason}</p>
                  </div>
                )}
                {taskAttachments.length > 0 && (
                  <div>
                    <span>附件（{taskAttachments.length}）</span>
                    <div className="stored-attachment-list">
                      {taskAttachments.map((attachment) => (
                        <a
                          href={`/api/tasks/${selectedTask.id}/attachments/${attachment.id}`}
                          key={attachment.id}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {attachment.content_type.startsWith('image/') ? (
                            /* oxlint-disable-next-line next/no-img-element */
                            <img
                              src={
                                attachment.url ??
                                `/api/tasks/${selectedTask.id}/attachments/${attachment.id}`
                              }
                              alt={attachment.name}
                            />
                          ) : (
                            <FileUp size={22} aria-hidden="true" />
                          )}
                          <span title={attachment.name}>
                            {attachment.name}
                            <small>
                              {formatAttachmentSize(attachment.size)}
                            </small>
                          </span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter>
                {selectedTask.assignee &&
                  actionsFor(selectedTask).some((action) =>
                    [
                      'start',
                      'pause',
                      'resume',
                      'submit',
                      'block',
                      'unblock',
                    ].includes(action),
                  ) &&
                  selectedTask.assignee !== actor && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setActor(selectedTask.assignee as Member)}
                    >
                      切换为负责人 {selectedTask.assignee}
                    </Button>
                  )}
                {actionsFor(selectedTask).map((action) => {
                  const needsDetail = Boolean(actionCopy[action].detail);
                  const employeeAction = [
                    'start',
                    'pause',
                    'resume',
                    'submit',
                    'block',
                    'unblock',
                  ].includes(action);
                  return (
                    <Button
                      key={action}
                      type="button"
                      variant={
                        action === 'block' || action === 'rework'
                          ? 'destructive'
                          : action === 'accept'
                            ? 'default'
                            : 'outline'
                      }
                      disabled={
                        busy ||
                        (employeeAction && selectedTask.assignee !== actor)
                      }
                      title={
                        employeeAction && selectedTask.assignee !== actor
                          ? `请先切换为负责人 ${selectedTask.assignee ?? '未指派'}`
                          : undefined
                      }
                      onClick={() =>
                        runAction(action, selectedTask, needsDetail)
                      }
                    >
                      {action === 'pause' && <Pause />}
                      {action === 'start' && <Play />}
                      {action === 'rework' && <RefreshCcw />}
                      {actionCopy[action].label}
                    </Button>
                  );
                })}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => {
          if (!open) {
            releaseImageDrafts(actionImages);
            setActionImages([]);
            setActionFiles([]);
            setPendingAction(null);
          }
        }}
      >
        <DialogContent className="task-dialog max-w-lg">
          {pendingAction && selectedTask && (
            <form onSubmit={submitDetailedAction}>
              <DialogHeader>
                <DialogTitle>{actionCopy[pendingAction].label}</DialogTitle>
                <DialogDescription>{selectedTask.title}</DialogDescription>
              </DialogHeader>
              <div className="field action-field">
                <span>
                  {actionCopy[pendingAction].detail}（支持图片与文件附件）
                </span>
                <PasteImageField
                  id="action-detail"
                  required={['submit', 'rework', 'block'].includes(
                    pendingAction,
                  )}
                  value={detail}
                  images={actionImages}
                  onImagesChange={setActionImages}
                  onChange={(event) => setDetail(event.target.value)}
                  placeholder={actionCopy[pendingAction].placeholder}
                />
                <FileAttachmentField
                  files={actionFiles}
                  onFilesChange={setActionFiles}
                />
              </div>
              {pendingAction === 'submit' && (
                <label
                  className="field action-field"
                  htmlFor="action-deliverable"
                >
                  <span>交付链接（可选）</span>
                  <Input
                    id="action-deliverable"
                    type="url"
                    value={deliverableUrl}
                    onChange={(event) => setDeliverableUrl(event.target.value)}
                    placeholder="https://"
                  />
                </label>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    releaseImageDrafts(actionImages);
                    setActionImages([]);
                    setActionFiles([]);
                    setPendingAction(null);
                  }}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  variant={
                    pendingAction === 'rework' || pendingAction === 'block'
                      ? 'destructive'
                      : 'default'
                  }
                  disabled={busy}
                >
                  {busy && <LoaderCircle className="spin" />}确认
                  {actionCopy[pendingAction].label}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
