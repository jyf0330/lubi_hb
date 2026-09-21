let dashboardGroups = [];
let dashboardScores = [];
let dashboardFirstSubmissionScores = [];
let dashboardProgress = [];
let dashboardTimelineEvents = [];
let dashboardTimelineSessions = [];
let dashboardTimelineProgress = [];
let dashboardServerTime = 0;
let dashboardDate = "";
let dashboardFreezeDate = "";
let dashboardApiRoot = null;
let ownerLoggedIn = false;
const statuses = ["今日待办", "进行中", "待验收", "需修改", "已完成", "阻塞", "已关闭"];
const PRIORITY_STATUSES = ["待验收", "阻塞", "需修改"];
const names = { ZHC: "赵浩丞", YWT: "余文滔", YWH: "余文浩" };
const TIMELINE_EMPLOYEES = ["ZHC", "YWT"];
const WORK_SECONDS = 25 * 60;
const REST_SECONDS = 5 * 60;
const CYCLE_SECONDS = WORK_SECONDS + REST_SECONDS;
let reminderSoundEnabled = false;
let previousPomodoroPhase = null;
let pendingReworkKey = null;
let reviewFiles = [];
let aiMessages = [];
let aiPeriod = "today";
let aiBusy = false;
const DEFAULT_REWORK_REASON = "时间不符需自述";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        c
      ],
  );
const clock = (ms) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(ms));
const shanghaiDate = (ms) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(ms))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const formatPoints = (points) =>
  Number(points).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const duration = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
function timing(t) {
  const reason = t.variance_reason ? `（${t.variance_reason}）` : "";
  const overdue = t.overdue ? " · 已延期" : "";
  return `实际 ${duration(Number(t.actual_minutes || 0) * 60000)} / 预计 ${duration(Number(t.estimated_minutes || 0) * 60000)} · ${["待验收", "已完成"].includes(t.status) ? (t.effort_status || "符合预估") : (Number(t.actual_minutes || 0) > Number(t.estimated_minutes || 0) ? "超出预估" : "尚未完成")}${reason}${overdue}`;
}
function meta(t) {
  if (t.status === "阻塞")
    return `${t.blocked_reason || "等待解除阻塞"}${t.overdue ? " · 已延期" : ""}`;
  if (t.status === "需修改") return `返工 ${t.rework_count} 次 · ${timing(t)}`;
  if (t.status === "待验收")
    return `${timing(t)} · ${t.first_submitted_at ? `${shanghaiDate(t.first_submitted_at)} ${clock(t.first_submitted_at)} 首次提交` : t.submitted_at ? `${shanghaiDate(t.submitted_at)} ${clock(t.submitted_at)} 提交` : "等待检查"}`;
  if (t.status === "已完成") return `验收通过 · ${timing(t)}`;
  return `${t.type} · 预计 ${t.estimated_minutes} 分钟${t.overdue ? " · 已延期" : ""}`;
}
function renderPendingReviews(tasks) {
  const pendingByDate = new Map();
  for (const task of tasks) {
    const submittedAt = task.first_submitted_at || task.submitted_at;
    const date = submittedAt ? shanghaiDate(submittedAt) : "日期未知";
    if (!pendingByDate.has(date)) pendingByDate.set(date, []);
    pendingByDate.get(date).push(task);
  }
  const groups = [...pendingByDate].sort(([a], [b]) =>
    a === "日期未知" ? 1 : b === "日期未知" ? -1 : b.localeCompare(a),
  );
  return groups
    .map(
      ([date, dateTasks]) =>
        `<section class="progress-pending-date"><h4>${esc(date === "日期未知" ? "提交日期未知" : `${date} 首次提交`)} <span>${dateTasks.length} 项</span></h4><div class="progress-pending-date-tasks">${dateTasks
          .map(
            (task) =>
              `<button type="button" class="action progress-pending-task" data-task-id="${esc(task.id)}"><span class="status-badge status-2">待验收</span><strong>${esc(task.title)}</strong><span>${esc(names[task.assignee] || task.assignee)} · ${esc(meta(task))}</span><span class="detail-link">查看详情 →</span></button>`,
          )
          .join("")}</div></section>`,
    )
    .join("");
}
function timeDetails(t) {
  const sessions = Array.isArray(t.time_sessions) ? t.time_sessions : [];
  if (!sessions.length) return "暂无计时记录";
  return sessions
    .map((session, index) => {
      const end = session.ended_at ? clock(session.ended_at) : "进行中";
      const reason = session.end_reason ? ` · ${session.end_reason}` : "";
      return `第 ${sessions.length - index} 段：开始时间 ${clock(session.started_at)} · 结束时间 ${end}${reason}`;
    })
    .join("\n");
}
function taskLifecycleMeta(t) {
  const sessions = Array.isArray(t.time_sessions) ? t.time_sessions : [];
  const startedAt = sessions.reduce((earliest, session) => {
    const value = Number(session.started_at);
    return Number.isFinite(value) && (earliest === null || value < earliest)
      ? value
      : earliest;
  }, null);
  const submittedAt = t.first_submitted_at ?? t.submitted_at ?? null;
  const timestamp = (value) =>
    value === null ? null : `${shanghaiDate(value)} ${clock(value)}`;
  return `开始工作时间：${timestamp(startedAt) || "未开始"} · 首次提交时间：${timestamp(submittedAt) || "未提交"}`;
}
function checkinMeta(task) {
  const checkin = task?.checkin;
  if (!checkin?.active) return null;
  if (checkin.due)
    return {
      due: true,
      label: `待汇报 ${checkin.overdue_minutes} 分钟`,
      detail: checkin.last_checkin ? heartbeatText(checkin.last_checkin) : "开始任务后尚未提交进展",
    };
  const remaining = Math.max(1, Number(checkin.remaining_minutes || 0));
  return {
    due: false,
    label: `${remaining} 分钟后汇报`,
    detail: checkin.last_checkin ? heartbeatText(checkin.last_checkin) : "等待首次进展",
  };
}
function heartbeatText(item) {
  const status = item.report_status || "进展";
  const detail = item.summary && item.summary !== status ? `：${item.summary}` : "";
  return `${status}${detail}`;
}

function timelineEventKind(eventType) {
  if (/评分|得分/.test(eventType)) return "score";
  if (/提交|审核|验收|退回|撤回/.test(eventType)) return "review";
  if (/计时/.test(eventType)) return "work";
  return "task";
}
function timelineEventDetail(event) {
  if (!event.detail) {
    if (event.from_status && event.to_status && event.from_status !== event.to_status)
      return `${event.from_status} → ${event.to_status}`;
    return event.to_status || "任务记录已更新";
  }
  try {
    const detail = JSON.parse(event.detail);
    if (detail && typeof detail === "object") {
      if (event.event_type === "管理员调整最终得分")
        return `${detail.previous_points ?? "未打分"} → ${detail.points} 点 · ${detail.reason || "负责人调整"}`;
      if (detail.points !== undefined)
        return detail.points == null ? (detail.reason || "未计分") : `${detail.points} 点${detail.reason ? ` · ${detail.reason}` : ""}`;
      if (detail.reason) return detail.reason;
    }
  } catch {}
  return event.detail;
}
function workingMinutesForDate(session, date) {
  const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  if (weekday === 0 || weekday === 6) return 0;
  const end = Math.min(Number(session.ended_at || dashboardServerTime || Date.now()), Date.parse(`${date}T23:59:59.999+08:00`));
  const start = Math.max(Number(session.started_at), Date.parse(`${date}T00:00:00+08:00`));
  if (end <= start) return 0;
  return [["09:30:00", "12:00:00"], ["14:00:00", "18:30:00"]].reduce((minutes, window) => {
    const from = Math.max(start, Date.parse(`${date}T${window[0]}+08:00`));
    const to = Math.min(end, Date.parse(`${date}T${window[1]}+08:00`));
    return minutes + Math.max(0, Math.floor((to - from) / 60000));
  }, 0);
}
function timelineAttention(tasks, date, assignee) {
  if (date !== dashboardDate) return [];
  const scoped = tasks.filter((task) => !assignee || task.assignee === assignee);
  const attention = [];
  for (const task of scoped) {
    if (task.status === "阻塞") attention.push({task, tone:"danger", title:"任务阻塞", detail:task.blocked_reason || "等待处理阻塞原因"});
    if (task.status === "需修改") attention.push({task, tone:"warning", title:"等待返工", detail:task.acceptance_result || "请查看验收要求"});
    if (task.checkin?.due) attention.push({task, tone:"warning", title:"HB 已到期", detail:`已超过汇报节点 ${task.checkin.overdue_minutes} 分钟`});
    if (task.effort_status === "超出预估" && !["已完成", "已关闭"].includes(task.status)) attention.push({task, tone:"warning", title:"已超出预估", detail:timing(task)});
    if (task.status === "待验收" && !(task.attachments || []).length && !(task.deliverables || []).length)
      attention.push({task, tone:"info", title:"交付证据待核对", detail:"没有附件或交付链接，请核对完成说明是否足够验收"});
  }
  return attention;
}
function renderTimeline() {
  const date = document.querySelector("#timeline-date").value || dashboardDate;
  const kind = document.querySelector("#timeline-kind").value;
  const query = document.querySelector("#timeline-search").value.trim().toLowerCase();
  const sessions = dashboardTimelineSessions.filter((session) => shanghaiDate(session.started_at) <= date && shanghaiDate(session.ended_at || dashboardServerTime || Date.now()) >= date);
  const progresses = dashboardTimelineProgress.filter((item) => shanghaiDate(item.created_at) === date);
  const rawEvents = dashboardTimelineEvents.filter((item) => shanghaiDate(item.created_at) === date && item.event_type !== "30分钟汇报" && !/计时/.test(item.event_type));
  const events = [
    ...sessions.map((session) => {
      const startedToday = shanghaiDate(session.started_at) === date;
      const endedToday = session.ended_at && shanghaiDate(session.ended_at) === date;
      const detail = startedToday
        ? `${clock(session.started_at)}${endedToday ? `–${clock(session.ended_at)}` : " 开始"}`
        : `跨日计时${endedToday ? ` · ${clock(session.ended_at)} 结束` : ""}`;
      return {
        task_id:session.task_id, assignee:session.assignee, title:session.title, type:"work",
        label:session.ended_at ? "计时记录" : "正在计时", created_at:startedToday ? session.started_at : Date.parse(`${date}T00:00:00+08:00`),
        time_label:startedToday ? clock(session.started_at) : "跨日",
        detail:`${detail} · 当日有效 ${workingMinutesForDate(session,date)} 分钟${session.end_reason ? ` · ${session.end_reason}` : ""}`,
      };
    }),
    ...progresses.map((item) => ({
      task_id:item.task_id, assignee:item.assignee, title:item.title, type:"progress", label:item.report_status || "HB 进展", created_at:item.created_at,
      detail:`${item.summary || "未填写说明"}${item.progress_percent == null ? "" : ` · ${item.progress_percent}%`}${item.next_step ? ` · 下一步：${item.next_step}` : ""}${item.blocker ? ` · 问题：${item.blocker}` : ""}`,
      images:item.images || [], attachments:item.attachments || [],
    })),
    ...rawEvents.map((item) => ({
      ...item, type:timelineEventKind(item.event_type), label:item.event_type, detail:timelineEventDetail(item),
    })),
  ].filter((item) => TIMELINE_EMPLOYEES.includes(item.assignee) && (!kind || item.type === kind) && (!query || `${item.title} ${item.label} ${item.detail}`.toLowerCase().includes(query)))
    .sort((a,b) => Number(b.created_at) - Number(a.created_at));
  const tasks = dashboardTasks;
  document.querySelector("#timeline-people").innerHTML = TIMELINE_EMPLOYEES.map((id) => {
    const ownSessions = sessions.filter((item) => item.assignee === id);
    const ownEvents = events.filter((item) => item.assignee === id);
    const taskCount = new Set(ownSessions.map((item) => item.task_id)).size;
    const minutes = ownSessions.reduce((sum,item) => sum + workingMinutesForDate(item,date), 0);
    const hbCount = progresses.filter((item) => item.assignee === id).length;
    const score = dashboardScores.find((item) => item.date === date && item.assignee === id) || {};
    const current = date === dashboardDate ? tasks.filter((item) => item.assignee === id && item.status === "进行中" && !item.is_paused).length : 0;
    const attention = timelineAttention(tasks,date,id);
    const feed = ownEvents.length ? ownEvents.map((item) => {
      const evidence = (item.images?.length || item.attachments?.length) ? ` · 附件 ${(item.images?.length || 0) + (item.attachments?.length || 0)} 个` : "";
      return `<button type="button" class="timeline-event kind-${item.type}" data-task-id="${esc(item.task_id)}"><span class="timeline-event-time"><time>${esc(item.time_label || clock(item.created_at))}</time><span>${esc(names[item.assignee] || item.assignee)}</span></span><span class="timeline-event-mark" aria-hidden="true"></span><span class="timeline-event-copy"><span class="timeline-event-label">${esc(item.label)}</span><strong>${esc(item.title)}</strong><span>${esc(item.detail)}${esc(evidence)}</span></span><span class="detail-link">任务详情 →</span></button>`;
    }).join("") : '<div class="empty">当前筛选条件下没有工作记录。</div>';
    const attentionHtml = date !== dashboardDate
      ? '<div class="empty-timeline-attention">历史日期展示事实记录；待处理提醒以今天的当前状态为准。</div>'
      : attention.length ? attention.map((item) => `<button type="button" class="timeline-alert ${item.tone}" data-task-id="${esc(item.task.id)}"><span>${esc(item.title)}</span><strong>${esc(item.task.title)}</strong><small>${esc(item.detail)}</small></button>`).join("") : '<div class="empty-timeline-attention">当前没有阻塞、返工、HB 超时或交付证据提醒。</div>';
    return `<article class="timeline-person-track ${id.toLowerCase()}" aria-labelledby="timeline-heading-${id}"><header class="timeline-person-header"><span class="timeline-person-title"><span class="avatar">${id}</span><span><small>员工工作轨迹</small><h3 id="timeline-heading-${id}">${esc(names[id])}</h3></span></span><span class="timeline-person-state">${date===dashboardDate ? `${current} 项正在计时` : `${date} 记录`}</span></header><div class="timeline-person-metrics"><span><b>${taskCount}</b> 项任务</span><span><b>${minutes}</b> 任务分钟</span><span><b>${hbCount}</b> 次 HB</span><span><b>${score.completed_count || 0}</b> 项完成</span><span><b>${formatPoints(score.points || 0)}</b> 点</span></div><section class="timeline-person-feed" aria-label="${esc(names[id])}的工作记录"><div class="timeline-section-heading"><div><small>按时间倒序</small><h4>工作记录</h4></div><span>${ownEvents.length} 条</span></div><div class="timeline-feed">${feed}</div></section><aside class="timeline-person-attention" aria-label="${esc(names[id])}的异常与关注"><div class="timeline-section-heading"><div><small>负责人待处理</small><h4>异常与关注</h4></div><b class="count">${attention.length}</b></div><div class="timeline-attention-list">${attentionHtml}</div></aside></article>`;
  }).join("");
  document.querySelector("#timeline-result-count").textContent = `${date} · ${events.length} 条记录`;
}

function shanghaiSeconds(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return parts.hour * 3600 + parts.minute * 60 + parts.second;
}

function pomodoroState() {
  const seconds = shanghaiSeconds();
  const morningStart = 9 * 3600 + 30 * 60;
  const morningEnd = 12 * 3600;
  const afternoonStart = 14 * 3600;
  const afternoonEnd = 18 * 3600 + 30 * 60;
  const windowStart =
    seconds >= morningStart && seconds < morningEnd
      ? morningStart
      : seconds >= afternoonStart && seconds < afternoonEnd
        ? afternoonStart
        : null;
  if (windowStart === null) {
    return {
      phase: "off",
      key: `off-${seconds < morningStart ? "morning" : seconds < afternoonStart ? "noon" : "evening"}`,
      remaining: 0,
      progress: 0,
      label:
        seconds < morningStart
          ? "09:30 开始上班"
          : seconds < afternoonStart
            ? "14:00 继续上班"
            : "今日已下班 · 明日 09:30",
    };
  }
  const elapsed = seconds - windowStart;
  const cycle = Math.floor(elapsed / CYCLE_SECONDS);
  const within = elapsed % CYCLE_SECONDS;
  const phase = within < WORK_SECONDS ? "work" : "rest";
  const phaseElapsed = phase === "work" ? within : within - WORK_SECONDS;
  const duration = phase === "work" ? WORK_SECONDS : REST_SECONDS;
  return {
    phase,
    key: `${windowStart}-${cycle}-${phase}`,
    remaining: duration - phaseElapsed,
    progress: phaseElapsed / duration,
    label: phase === "work" ? "专注 25 分钟" : "休息 5 分钟",
  };
}

function playReminder(kind) {
  const context = new AudioContext();
  const master = context.createGain();
  const durationSeconds = kind === "rework" ? 30 : 15;
  const notes =
    kind === "rest"
      ? [880, 1174]
      : kind === "work"
        ? [523, 659, 784, 1046]
        : [523, 659, 784, 659, 587, 698, 880, 698];
  const spacing = kind === "rest" ? 1.5 : 0.5;
  const noteLength = kind === "rest" ? 0.55 : 0.36;
  master.gain.setValueAtTime(0.0001, context.currentTime);
  master.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.04);
  master.gain.setValueAtTime(0.18, context.currentTime + durationSeconds - 0.2);
  master.gain.exponentialRampToValueAtTime(
    0.0001,
    context.currentTime + durationSeconds,
  );
  master.connect(context.destination);
  for (let offset = 0; offset < durationSeconds; offset += spacing) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + offset;
    oscillator.type = kind === "rest" ? "sine" : "triangle";
    oscillator.frequency.value = notes[Math.floor(offset / spacing) % notes.length];
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.5, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + noteLength);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(start);
    oscillator.stop(start + noteLength + 0.02);
  }
  setTimeout(() => context.close(), (durationSeconds + 0.5) * 1000);
}

function notifyRest() {
  const originalTitle = document.title;
  let alternate = false;
  const flashing = setInterval(() => {
    alternate = !alternate;
    document.title = alternate ? "休息 5 分钟｜露比工作室" : originalTitle;
  }, 800);
  setTimeout(() => {
    clearInterval(flashing);
    document.title = originalTitle;
  }, 15000);
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const notification = new Notification("该休息了", {
    body: "已专注 25 分钟，请休息 5 分钟。点击返回工作看板。",
    tag: "pomodoro-rest",
    requireInteraction: true,
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
  setTimeout(() => notification.close(), 15000);
}

function updatePomodoro() {
  const state = pomodoroState();
  const panel = document.querySelector("#pomodoro");
  panel.className = `pomodoro phase-${state.phase}`;
  document.querySelector("#pomodoro-phase").textContent =
    state.phase === "work" ? "专注中" : state.phase === "rest" ? "休息中" : "非工作时段";
  document.querySelector("#pomodoro-label").textContent = state.label;
  document.querySelector("#pomodoro-countdown").textContent =
    state.phase === "off"
      ? "--:--"
      : `${String(Math.floor(state.remaining / 60)).padStart(2, "0")}:${String(state.remaining % 60).padStart(2, "0")}`;
  document.querySelector("#pomodoro-bar").style.width = `${state.progress * 100}%`;
  if (previousPomodoroPhase && previousPomodoroPhase !== state.key) {
    if (state.phase === "rest") {
      notifyRest();
      if (reminderSoundEnabled) playReminder("rest");
    } else if (state.phase === "work" && reminderSoundEnabled) {
      playReminder("work");
    }
  }
  previousPomodoroPhase = state.key;
}

function seenReworks() {
  try {
    const value = JSON.parse(localStorage.getItem("seen-reworks") || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function detectReworks(tasks) {
  const seen = seenReworks();
  pendingReworkKey =
    tasks
      .filter((task) => task.status === "需修改")
      .map((task) => `${task.id}:${task.rework_count}`)
      .find((key) => !seen.has(key)) || null;
  document.querySelector("#rework-alert").hidden = !pendingReworkKey;
  if (!pendingReworkKey || !reminderSoundEnabled) return;
  playReminder("rework");
  seen.add(pendingReworkKey);
  localStorage.setItem("seen-reworks", JSON.stringify([...seen]));
  pendingReworkKey = null;
  document.querySelector("#rework-alert").hidden = true;
}

document.querySelector("#enable-reminders").addEventListener("click", async (event) => {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  reminderSoundEnabled = true;
  event.currentTarget.textContent = "提醒已开启";
  event.currentTarget.disabled = true;
  if (pendingReworkKey) {
    const seen = seenReworks();
    playReminder("rework");
    seen.add(pendingReworkKey);
    localStorage.setItem("seen-reworks", JSON.stringify([...seen]));
    pendingReworkKey = null;
    document.querySelector("#rework-alert").hidden = true;
  }
});

async function refresh() {
  const response = await fetch("api/dashboard", { cache: "no-store" });
  if (!response.ok) throw new Error("服务器数据读取失败");
  const data = await response.json();
  dashboardGroups = data.groups || [];
  dashboardScores = data.scores || [];
  dashboardFirstSubmissionScores = data.first_submission_scores || [];
  dashboardDate = data.date;
  dashboardFreezeDate = data.freeze_date || "";
  dashboardServerTime = Number(data.server_time || Date.now());
  dashboardTimelineEvents = data.timeline_events || [];
  dashboardTimelineSessions = data.timeline_sessions || data.sessions || [];
  dashboardTimelineProgress = data.timeline_progress || data.progress_updates || [];
  const timelineDate = document.querySelector("#timeline-date");
  const sevenDayMin = shanghaiDate(Date.parse(`${dashboardDate}T00:00:00+08:00`) - 6 * 86400000);
  const timelineMin = dashboardFreezeDate && dashboardFreezeDate > sevenDayMin ? dashboardFreezeDate : sevenDayMin;
  timelineDate.max = dashboardDate;
  timelineDate.min = timelineMin;
  if (!timelineDate.value || timelineDate.value < timelineMin) timelineDate.value = dashboardDate;
  const freezeBanner = document.querySelector("#data-freeze-banner");
  freezeBanner.hidden = !dashboardFreezeDate;
  freezeBanner.textContent = dashboardFreezeDate
    ? `数据冻结已生效：工作台只显示 ${dashboardFreezeDate}（含）之后的新数据，更早记录在这里视为不存在。`
    : "";
  const freezeInput = document.querySelector("#data-freeze-date");
  freezeInput.max = dashboardDate;
  freezeInput.value = dashboardFreezeDate || dashboardDate;
  const tasks = data.tasks.map(t=>({...t,group_title:dashboardGroups.find(g=>g.id===t.group_id)?.title||''}));
  detectReworks(tasks);
  const sessions = data.sessions;
  document.querySelector("#today").textContent = `今天 · ${data.date}`;
  const people = ["ZHC", "YWT", "YWH"].map((id) => {
    const own = tasks.filter((t) => t.assignee === id),
      active = own.find((t) => t.priority === "高") || own.find((t) => t.status === "进行中" && !t.is_paused),
      session = active
        ? sessions.find((s) => s.task_id === active.id && !s.ended_at)
        : null,
      todayScore = dashboardScores.find(r=>r.date===data.date&&r.assignee===id);
    return { id, own, active, session, todayScore };
  });
  const recentScore = dashboardScores.reduce((sum, row) => sum + row.points, 0),
    waiting = tasks.filter((t) => t.status === "待验收"),
    blocked = tasks.filter((t) => t.status === "阻塞"),
    active = people.filter(p=>p.own.some(t=>t.status==='进行中'&&!t.is_paused)).length,
    overrun = tasks.filter((t) => t.effort_status === "超出预估"),
    overdue = tasks.filter((t) => t.overdue),
    checkinDue = people.filter((p) => p.active?.checkin?.due);
  document.querySelector("#planned").textContent = `${tasks.filter(t=>t.status!=='已完成').length} 项`;
  document.querySelector("#done").textContent = `${formatPoints(recentScore)} 点`;
  document.querySelector("#rate").textContent = "点击查看每天完成了什么 →";
  document.querySelector("#review-count").textContent = `${waiting.length} 项`;
  document.querySelector("#blocked-count").textContent = `${blocked.length} 项`;
  document.querySelector("#brief-title").textContent =
    `${active} 人正在执行任务，${blocked.length ? `${blocked.length} 项阻塞` : "当前无阻塞"}`;
  document.querySelector("#brief-copy").textContent =
    `${tasks.filter(t=>t.priority==='高').length} 项高优先临时插单，${waiting.length} 项等待你审核打分。员工可自行暂停或并行。`;
  document.querySelector("#people").innerHTML = [...people].sort((a,b)=>Number(Boolean(b.session))-Number(Boolean(a.session)))
    .map((p) => {
      const recent = dashboardScores.filter(r=>r.assignee===p.id).reduce((n,r)=>n+r.points,0),
        checkin = checkinMeta(p.active);
      const tag = p.active ? "button" : "article",
        action = p.active
          ? ` type="button" data-person-task-id="${esc(p.active.id)}" aria-label="查看 ${esc(names[p.id])} 的任务详情"`
          : "",
        actionClass = p.active ? " person-action" : "";
      return `<${tag} class="person ${p.id.toLowerCase()}${actionClass}"${action}><div class="person-top"><div class="avatar">${p.id}</div><div><small>${esc(names[p.id])}</small><h3>${p.active?.priority==='高'?'高优先 · ':''}${esc(p.active?.title || "当前没有进行中的任务")}</h3><p>${p.session ? `${esc(p.active.type)} · ${clock(p.session.started_at)} 开始` : p.active?.status==='待验收'?"等待审核 · 已停止计时":p.active?"当前未计时":"尚未开始计时"}</p></div><span class="state">${p.active?.is_paused ? "已暂停" : esc(p.active?.status || "未记录")}</span></div>${checkin ? `<div class="checkin ${checkin.due ? "due" : "ok"}"><strong>${esc(checkin.label)}</strong><span>${esc(checkin.detail)}</span></div>` : ""}<div class="bar-copy"><span>今日完成 ${p.todayScore?.completed_count||0} 项 · ${formatPoints(p.todayScore?.points||0)} 点</span><span>近 7 天 ${formatPoints(recent)} 点</span></div><p>正在计时 ${p.own.filter(t=>t.status==='进行中'&&!t.is_paused).length} 项${p.active?.priority==='高'?' · 高优先通常两小时以内':''}</p>${p.active ? '<span class="person-detail-link">查看任务详情 →</span>' : ""}</${tag}>`;
    })
    .join("");
  const progress = data.progress_updates || [];
  dashboardProgress = progress;
  dashboardApiRoot = new URL("api/", location.href);
  document.querySelector("#progress-count").textContent =
    `今日 ${progress.length} 次 · ${new Set(progress.map((item) => item.assignee)).size} 人`;
  const pendingAcceptance = tasks.filter((task) => task.status === "待验收");
  document.querySelector("#progress-pending-count").textContent =
    `${pendingAcceptance.length} 项`;
  document.querySelector("#progress-pending").innerHTML = pendingAcceptance.length
    ? renderPendingReviews(pendingAcceptance)
    : '<div class="empty">当前没有待验收任务</div>';
  document.querySelector("#progress-people").innerHTML = ["ZHC", "YWT", "YWH"]
    .map((id) => {
      const own = progress.filter((item) => item.assignee === id);
      const latest = own[0];
      const screenshotCount = own.reduce(
        (count, item) => count + (item.images || []).length,
        0,
      );
      return `<button type="button" class="progress-person ${id.toLowerCase()}" data-progress-person="${id}">
        <span class="progress-person-top"><span class="avatar">${id}</span><span><small>${esc(names[id])}</small><strong>${latest ? `${own.length} 次汇报` : "今天暂无汇报"}</strong></span><span class="detail-link">${latest ? "查看详情 →" : "查看记录 →"}</span></span>
        <span class="progress-person-latest">${latest ? `<time>${reportTimestamp(latest.created_at, dashboardDate)}</time><b>${esc(latest.title)}</b><span>${esc(heartbeatText(latest))}</span>` : "点击查看该成员的详细工作记录"}</span>
        <span class="progress-person-foot">${screenshotCount ? `截图 ${screenshotCount} 张` : "暂无截图"}${latest?.next_step ? ` · 下一步：${esc(latest.next_step)}` : ""}${reportImagePreviewStrip(latest?.images, dashboardApiRoot)}</span>
      </button>`;
    })
    .join("");
  dashboardTasks = (data.all_tasks || data.tasks).map(t=>({...t,group_title:dashboardGroups.find(g=>g.id===t.group_id)?.title||''}));
  renderScoreHistory();
  renderTasks();
  renderClosedTasks();
  const reports = data.reports || [],
    tomorrow = data.tomorrow_tasks || [];
  document.querySelector("#report-count").textContent =
    `${reports.length} / 3 人已提交`;
  document.querySelector("#reports").innerHTML = ["ZHC", "YWT", "YWH"]
    .map((id) => {
      const report = reports.find((r) => r.assignee === id);
      return `<article class="daily-card"><div class="daily-title"><strong>${esc(names[id])}</strong><span>${report ? `${clock(report.submitted_at)} 提交` : "未提交"}</span></div><p>${report ? esc(report.summary) : "今日总结尚未提交。"}</p></article>`;
    })
    .join("");
  document.querySelector("#tomorrow").innerHTML = ["ZHC", "YWT", "YWH"]
    .map((id) => {
      const list = tomorrow.filter((t) => t.assignee === id),
        points = list.reduce((a, t) => a + Number(t.planned_points), 0);
      return `<article class="daily-card"><div class="daily-title"><strong>${esc(names[id])}</strong><span>${list.length} 项</span></div>${list.length ? `<ul>${list.map((t) => `<li><b>${esc(t.title)}</b><small>${esc(t.type)} · ${t.estimated_minutes} 分钟</small></li>`).join("")}</ul>` : "<p>尚未安排明日任务</p>"}</article>`;
    })
    .join("");
  renderTimeline();
  const actionSections = collectPriorityActionSections(tasks, dashboardGroups);
  const actionCount = new Set(
    PRIORITY_STATUSES.flatMap((status) => actionSections[status].map((entry) => entry.key)),
  ).size;
  document.querySelector("#action-count").textContent = actionCount;
  for (const status of PRIORITY_STATUSES) {
    document.querySelector(`#action-count-${priorityStatusId(status)}`).textContent =
      actionSections[status].length;
  }
  priorityActionSections = Object.fromEntries(
    PRIORITY_STATUSES.map((status) => [
      status,
      actionSections[status].map((entry) =>
        entry.type === "group"
          ? renderActionGroup(entry.group, entry.tasks, entry.ready)
          : renderActionCard(entry.task),
      ),
    ]),
  );
  renderPriorityActionStatus(document.querySelector("#actions").dataset.status || "待验收");
}
let dashboardTasks = [];
let priorityActionSections = {};
function priorityStatusId(status) {
  return ({ 待验收: "review", 阻塞: "blocked", 需修改: "rework" })[status];
}
function collectPriorityActionSections(tasks, groups) {
  const sections = Object.fromEntries(PRIORITY_STATUSES.map((status) => [status, []]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const groupedChildIds = new Set();
  for (const group of groups) {
    const children = group.tasks || [];
    children.forEach((child) => groupedChildIds.add(child.id));
    const ready = Boolean(group.ready_for_acceptance);
    for (const status of PRIORITY_STATUSES) {
      // Group acceptance remains all-or-nothing: pending children stay hidden
      // until every child is submitted, while blocked/rework children remain actionable.
      const visible = children
        .filter((child) => child.status === status)
        .filter(() => status !== "待验收" || ready)
        .map((child) => ({ ...child, ...(taskById.get(child.id) || {}) }));
      if (visible.length) {
        sections[status].push({
          type: "group",
          key: `group:${group.id}`,
          group,
          tasks: visible,
          ready: status === "待验收" && ready,
        });
      }
    }
  }
  for (const task of tasks) {
    if (groupedChildIds.has(task.id) || !PRIORITY_STATUSES.includes(task.status)) continue;
    sections[task.status].push({ type: "task", key: `task:${task.id}`, task });
  }
  return sections;
}
function renderPriorityActionStatus(status) {
  const selected = PRIORITY_STATUSES.includes(status) ? status : "待验收";
  const panel = document.querySelector("#actions");
  panel.dataset.status = selected;
  panel.setAttribute("aria-labelledby", `action-tab-${priorityStatusId(selected)}`);
  for (const button of document.querySelectorAll("[data-action-status]")) {
    const active = button.dataset.actionStatus === selected;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  const entries = priorityActionSections[selected] || [];
  panel.innerHTML = entries.length
    ? entries.join("")
    : `<div class="empty">当前没有${selected}事项</div>`;
}
for (const button of document.querySelectorAll("[data-action-status]")) {
  button.addEventListener("click", () => renderPriorityActionStatus(button.dataset.actionStatus));
  button.addEventListener("keydown", (event) => {
    const current = PRIORITY_STATUSES.indexOf(button.dataset.actionStatus);
    const next = event.key === "ArrowRight"
      ? (current + 1) % PRIORITY_STATUSES.length
      : event.key === "ArrowLeft"
        ? (current + PRIORITY_STATUSES.length - 1) % PRIORITY_STATUSES.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? PRIORITY_STATUSES.length - 1
            : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = document.querySelector(`[data-action-status="${PRIORITY_STATUSES[next]}"]`);
    renderPriorityActionStatus(PRIORITY_STATUSES[next]);
    target.focus();
  });
}
const pages = ['overview','board','closed','progress','daily','timeline','ai-analysis'];
function showPage(page, update=false) {
  if (!pages.includes(page)) page='overview';
  for (const key of pages) {
    document.getElementById(key).hidden=key!==page;
    const button=document.querySelector(`[data-page="${key}"]`);
    button.setAttribute('aria-selected',String(key===page));
    button.tabIndex=key===page?0:-1;
  }
  if(update)history.replaceState(null,'','#'+page);
}
document.querySelectorAll('[data-page]').forEach(button=>{
  button.onclick=()=>showPage(button.dataset.page,true);
  button.onkeydown=e=>{
    const i=pages.indexOf(button.dataset.page);
    const next=e.key==='ArrowRight'?(i+1)%pages.length:e.key==='ArrowLeft'?(i+pages.length-1)%pages.length:e.key==='Home'?0:e.key==='End'?pages.length-1:null;
    if(next===null)return;e.preventDefault();showPage(pages[next],true);document.querySelector(`[data-page="${pages[next]}"]`).focus();
  };
});
window.addEventListener('hashchange',()=>showPage(location.hash.slice(1)));
showPage(location.hash.slice(1));
function renderActionCard(t, nested=false){
  return `<button type="button" class="action${nested?' action-child':''}" data-task-id="${esc(t.id)}"><span class="status-badge status-${statuses.indexOf(t.status)}">${esc(t.status)}</span><strong>${esc(t.title)}</strong><span>${esc(names[t.assignee]||t.assignee)} · ${esc(meta(t))}</span><span class="detail-link">查看详情 →</span></button>`;
}
function renderActionGroup(group, tasks, ready){
  const suggested = formatPoints(group.suggested_points || 0);
  const missingScore = group.suggested_complete === false;
  const review = ready
    ? `<div class="action-group-review"><span>员工建议总分 <strong>${suggested} 点</strong>${missingScore?' · 部分小任务未填自评分':''}</span>${ownerLoggedIn?`<button type="button" class="primary" data-group-review="${esc(group.id)}"${missingScore?' disabled title="有小任务缺少员工自评分，请先在小任务里补齐"':''}>一次验收大任务（${suggested} 点）</button>`:'<span class="hint">登录负责人身份后可一次验收</span>'}</div>`
    : "";
  const heading = ready
    ? `大任务已全部提交 · ${group.total_count} 个小任务待一次验收`
    : `${esc(names[group.assignee]||group.assignee)} · ${esc(group.status)} · ${tasks.length} / ${group.total_count} 个小任务需处理`;
  const children = tasks.length
    ? `<details class="action-group-details" open><summary>查看小任务（${tasks.length} 项）</summary><div class="action-group-children">${tasks.map(t=>renderActionCard(t,true)).join('')}</div></details>`
    : "";
  return `<article class="action action-group"><div class="action-group-heading"><span class="action-group-label">大任务</span><strong>${esc(group.title)}</strong><span>${heading}</span></div>${review}${children}</article>`;
}
function taskMatchesFilters(t, filters){
  return (!filters.owner||t.assignee===filters.owner)&&(!filters.status||t.status===filters.status)&&(!filters.date||t.planned_date===filters.date)&&(!filters.search||(t.title+' '+(t.group_title||'')).toLowerCase().includes(filters.search));
}
function renderTasks(){
  const filters={owner:document.querySelector('#owner-filter').value,status:document.querySelector('#status-filter').value,date:document.querySelector('#date-filter').value,search:document.querySelector('#task-search').value.trim().toLowerCase()};
  const rank={'待验收':0,'阻塞':1,'需修改':2,'进行中':3,'今日待办':4,'已完成':5,'已关闭':6};
  const list=dashboardTasks.filter(t=>taskMatchesFilters(t,filters)).sort((a,b)=>Number(b.priority==='高')-Number(a.priority==='高')||rank[a.status]-rank[b.status]);
  document.querySelector('#task-total').textContent=`显示 ${list.length} / ${dashboardTasks.length} 项`;
  document.querySelector('#task-groups').innerHTML=dashboardGroups.filter(g=>(!filters.owner||g.assignee===filters.owner)&&(!filters.status||g.status===filters.status)&&(!filters.search||(g.title+' '+g.tasks.map(t=>t.title).join(' ')).toLowerCase().includes(filters.search))&&(!filters.date||g.tasks.some(t=>t.planned_date===filters.date))).map(g=>`<article class="group-summary"><strong>${esc(g.title)}</strong><p>${esc(names[g.assignee]||g.assignee)} · ${esc(g.status)} · 验收通过 ${g.completed_count}/${g.total_count} 项${g.pending_count?` · 待验收 ${g.pending_count} 项 · 员工建议合计 ${formatPoints(g.suggested_points)} 点`:''}${g.status==='已完成'?` · 最终得分 ${formatPoints(g.awarded_points)} 点`:''} · ${g.stated_minutes==null?'未填写大任务参考时间':'大任务参考 '+g.stated_minutes+' 分钟'} · 小任务合计 ${g.estimated_minutes} 分钟 · 已记录 ${g.actual_minutes} 分钟</p><details><summary>交付与验收要求</summary><p>${esc(g.deliverable_expectation)}</p><p>${esc(g.acceptance_criteria)}</p></details></article>`).join('');
  document.querySelector('#kanban').innerHTML=list.length?list.map(t=>`<button type="button" class="task task-row" data-task-id="${esc(t.id)}"><span class="task-main"><strong>${t.priority==='高'?'高优先 · ':''}${esc(t.title)}</strong>${t.group_title?`<span class="task-meta">所属大任务：${esc(t.group_title)}</span>`:''}<span class="task-meta">${esc(names[t.assignee]||t.assignee||'未指派')} · ${esc(t.planned_date?`计划 ${t.planned_date}`:'未排期')} · ${esc(meta(t))}</span><span class="task-meta task-lifecycle">${esc(taskLifecycleMeta(t))}</span></span><span class="status-badge status-${statuses.indexOf(t.status)}">${esc(t.is_paused?'已暂停':t.status)}</span><span class="detail-link">查看详情 →</span></button>`).join(''):'<div class="empty">没有符合条件的任务，可调整或清除筛选。</div>';
}
for(const id of ['owner-filter','status-filter','date-filter','task-search'])document.getElementById(id).addEventListener('input',renderTasks);
document.querySelector('#clear-filters').onclick=()=>{for(const id of ['owner-filter','status-filter','date-filter','task-search'])document.getElementById(id).value='';renderTasks();};
document.querySelectorAll('[data-status-jump]').forEach(button=>button.onclick=()=>{
  document.querySelector('#status-filter').value=button.dataset.statusJump;document.querySelector('#owner-filter').value='';document.querySelector('#date-filter').value='';document.querySelector('#task-search').value='';renderTasks();showPage('board',true);
});
function renderClosedTasks(){
  const list=dashboardTasks.filter(t=>t.status==='已关闭').sort((a,b)=>Number(b.updated_at)-Number(a.updated_at));
  document.querySelector('#closed-count').textContent=`${list.length} 项`;
  document.querySelector('#closed-tasks').innerHTML=list.length?list.map(t=>`<button type="button" class="task task-row" data-task-id="${esc(t.id)}"><span class="task-main"><strong>${esc(t.title)}</strong>${t.group_title?`<span class="task-meta">所属大任务：${esc(t.group_title)}</span>`:''}<span class="task-meta">${esc(names[t.assignee]||t.assignee||'未指派')} · ${esc(t.close_reason||'管理员关闭')}</span></span><span class="status-badge status-${statuses.indexOf(t.status)}">已关闭</span><span class="detail-link">查看详情 →</span></button>`).join(''):'<div class="empty">目前没有已关闭的任务</div>';
}
function renderTaskEvidence(t){
  const deliverables = (t.deliverables || []).map((item) => `<li><a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.label || item.kind || "交付链接")} ↗</a></li>`).join("");
  const progress = dashboardTimelineProgress.filter((item) => item.task_id === t.id).slice(0,8);
  const events = dashboardTimelineEvents.filter((item) => item.task_id === t.id && item.event_type !== "30分钟汇报").slice(0,12);
  const progressHtml = progress.length ? `<section class="detail-activity"><h4>HB 进展</h4>${progress.map((item) => `<article><header><time>${shanghaiDate(item.created_at)} ${clock(item.created_at)}</time><span>${esc(item.report_status || "进展")}</span></header><p>${esc(item.summary || "未填写具体说明")}</p>${item.next_step?`<small>下一步：${esc(item.next_step)}</small>`:""}${item.blocker?`<small class="blocker">问题：${esc(item.blocker)}</small>`:""}${reportImageGallery(item.images,dashboardApiRoot)}${reportFileGallery(item.attachments,dashboardApiRoot)}</article>`).join("")}</section>` : "";
  const eventsHtml = events.length ? `<section class="detail-activity"><h4>任务操作记录</h4>${events.map((item) => `<article class="detail-event"><header><time>${shanghaiDate(item.created_at)} ${clock(item.created_at)}</time><span>${esc(names[item.actor] || item.actor)}</span></header><strong>${esc(item.event_type)}</strong><p>${esc(timelineEventDetail(item))}</p></article>`).join("")}</section>` : "";
  const evidence = deliverables || (t.attachments || []).length ? `<section class="detail-evidence"><h4>交付证据</h4>${deliverables?`<ul>${deliverables}</ul>`:""}${taskAttachmentGallery(t.attachments,dashboardApiRoot)}</section>` : '<section class="detail-evidence empty-evidence"><h4>交付证据</h4><p>暂未上传附件或交付链接，可结合完成说明与 HB 记录验收。</p></section>';
  return evidence + progressHtml + eventsHtml;
}
function showDetail(id){
  const t=dashboardTasks.find(t=>t.id===id);if(!t)return;
  let appendReason='';if(t.notes){try{appendReason=JSON.parse(t.notes).append_reason||'';}catch{}}
  const fields=[['所属大任务',t.group_title],['负责人',names[t.assignee]||t.assignee||'未指派'],['状态',t.is_paused?'已暂停':t.status],['关闭时间',t.closed_at?`${shanghaiDate(t.closed_at)} ${clock(t.closed_at)}`:''],['关闭人',t.closed_by],['关闭说明',t.close_reason],['用时',timing(t)],['用时详情',timeDetails(t)],['交付内容',t.deliverable_expectation],['验收标准',t.acceptance_criteria],['优先级',t.priority==='高'?'高优先 · 负责人临时插单':'正常'],['完成说明',t.result_summary],['补充原因',appendReason],['员工自评分',t.employee_ai_points==null?'未填写':t.employee_ai_points+' 点'+(t.employee_ai_reason?' · '+t.employee_ai_reason:'')],['平台 AI 建议',t.platform_ai_points==null?'尚未生成':t.platform_ai_points+' 点 · '+t.platform_ai_reason],['最终得分',t.awarded_points==null?'未打分':t.awarded_points+' 点'],['验收结果',t.acceptance_result],['阻塞原因',t.blocked_reason]];
  const shortLabels=new Set(['所属大任务','负责人','状态','用时','优先级','员工自评分','最终得分']);
  const items=fields.filter(([,v])=>v!==null&&v!==undefined&&v!=='');
  const chips=items.filter(([label])=>shortLabels.has(label)).map(([label,value])=>'<span class="detail-chip"><b>'+label+'</b>'+esc(value)+'</span>').join('');
  const details=items.filter(([label])=>!shortLabels.has(label)).map(([label,value])=>'<div class="detail-field"><dt>'+label+'</dt><dd>'+esc(value)+'</dd></div>').join('');
  const canReview=t.status==='待验收';
  const canEditScore=ownerLoggedIn&&t.status==='已完成';
  const content=document.querySelector('#detail-content');
  const canClose=ownerLoggedIn&&['阻塞','需修改'].includes(t.status);
  content.classList.toggle('has-review',canReview||canClose||canEditScore);
  content.innerHTML='<section class="detail-main"><h3>'+esc(t.title)+'</h3>'+(chips?'<div class="detail-chips">'+chips+'</div>':'')+(details?'<dl class="detail-fields">'+details+'</dl>':'')+renderTaskEvidence(t)+'</section>'+(canReview||canClose||canEditScore?'<aside class="detail-side" id="detail-side"></aside>':'');
  appendReviewForm(t);
  appendCloseTaskForm(t);
  appendScoreEditForm(t);
  document.querySelector('#task-detail').showModal();
  clampDetailFields();
}
function clampDetailFields(){
  document.querySelectorAll('#detail-content .detail-field dd').forEach(dd=>{
    dd.classList.add('is-clamped');
    if(dd.scrollHeight<=dd.clientHeight+1){dd.classList.remove('is-clamped');return;}
    const button=document.createElement('button');
    button.type='button';button.className='detail-expand';button.textContent='展开全文';
    button.onclick=()=>{const folded=dd.classList.toggle('is-clamped');button.textContent=folded?'展开全文':'收起';};
    dd.after(button);
  });
}
async function reviewGroup(groupId,button){
  const group=dashboardGroups.find(g=>g.id===groupId);
  if(!group)return;
  const total=formatPoints(group.suggested_points||0);
  if(!confirm(`确认一次验收大任务“${group.title}”？\n将按员工自评分合计 ${total} 点，直接通过其中 ${group.total_count} 个小任务。`))return;
  button.disabled=true;
  try{await ownerApi('action',{action:'owner_review_group',args:{group_id:group.id}});await loadDashboard();}
  catch(error){alert(error.message);button.disabled=false;}
}
for(const id of ['kanban','closed-tasks','actions','progress-pending','timeline-people'])document.getElementById(id).onclick=e=>{const review=e.target.closest('[data-group-review]');if(review){reviewGroup(review.dataset.groupReview,review);return;}const button=e.target.closest('[data-task-id]');if(button)showDetail(button.dataset.taskId);};
document.querySelector('#people').onclick=e=>{const card=e.target.closest('[data-person-task-id]');if(card)showDetail(card.dataset.personTaskId);};
document.querySelector('#daily-completion-scores').onclick=e=>{const button=e.target.closest('[data-task-id]');if(button)showDetail(button.dataset.taskId);};
for(const id of ['timeline-date','timeline-kind','timeline-search'])document.getElementById(id).addEventListener('input',renderTimeline);
document.querySelector('#timeline-clear').onclick=()=>{document.querySelector('#timeline-date').value=dashboardDate;document.querySelector('#timeline-kind').value='';document.querySelector('#timeline-search').value='';renderTimeline();};
document.querySelector('#timeline-score-jump').onclick=()=>document.querySelector('#score-history-panel').scrollIntoView({behavior:'smooth',block:'start'});
document.querySelector('#close-detail').onclick=()=>document.querySelector('#task-detail').close();
document.querySelector('[data-score-details]').onclick=()=>document.querySelector('#score-history-panel').scrollIntoView({behavior:'smooth',block:'center'});
function showProgressDetail(assignee){
  const items = dashboardProgress.filter((item) => item.assignee === assignee);
  document.querySelector('#progress-detail-title').textContent = `${names[assignee] || assignee} · 今日汇报`;
  document.querySelector('#progress-detail-content').innerHTML = items.length
    ? items.map((item) => `<article class="progress-detail-item">
        <header><time>${reportTimestamp(item.created_at, dashboardDate)}</time><span class="progress-status">${esc(item.report_status || "进展")}</span></header>
        <h3>${esc(item.title)}</h3>
        <p>${esc(item.summary || "未填写具体说明")}</p>
        ${item.next_step ? `<div class="progress-detail-note"><b>下一步</b>${esc(item.next_step)}</div>` : ""}
        ${item.blocker ? `<div class="progress-detail-note blocker"><b>问题</b>${esc(item.blocker)}</div>` : ""}
        ${reportImageGallery(item.images, dashboardApiRoot)}
      </article>`).join("")
    : '<div class="empty">今天还没有该成员的进展汇报。</div>';
  document.querySelector('#progress-detail').showModal();
}
document.querySelector('#progress-people').onclick = (event) => {
  const button = event.target.closest('[data-progress-person]');
  if (button) showProgressDetail(button.dataset.progressPerson);
};
document.querySelector('#close-progress-detail').onclick = () => document.querySelector('#progress-detail').close();
function renderScoreHistory(scoreRows=dashboardScores,tasks=dashboardTasks,firstRows=dashboardFirstSubmissionScores,currentDate=dashboardDate){
  const dates=[...new Set(scoreRows.map(row=>row.date))].reverse();
  document.querySelector('#daily-completion-scores').innerHTML=dates.map(date=>{
    const dayRows=scoreRows.filter(row=>row.date===date);
    const dayTasks=tasks.filter(task=>task.status==='已完成'&&task.completed_at&&shanghaiDate(task.completed_at)===date);
    const totalPoints=dayRows.reduce((sum,row)=>sum+Number(row.points||0),0);
    const totalTasks=dayRows.reduce((sum,row)=>sum+Number(row.completed_count||0),0);
    const unscored=dayRows.reduce((sum,row)=>sum+Number(row.unscored_count||0),0);
    const people=Object.keys(names).map(member=>{
      const row=dayRows.find(item=>item.assignee===member)||{points:0,completed_count:0,unscored_count:0};
      const own=dayTasks.filter(task=>task.assignee===member).sort((a,b)=>Number(b.first_submitted_at??b.submitted_at??0)-Number(a.first_submitted_at??a.submitted_at??0)||Number(b.completed_at)-Number(a.completed_at));
      const list=own.length?`<ul>${own.map(task=>`<li><button type="button" class="score-task" data-task-id="${esc(task.id)}"><span><b>${esc(task.title)}</b><small>${task.group_title?`小任务 · 所属大任务：${esc(task.group_title)} · `:'历史任务（未区分大小） · '}${esc(taskLifecycleMeta(task))}</small></span><strong class="score-value">${task.awarded_points==null?'未打分':formatPoints(task.awarded_points)+' 点'}</strong></button></li>`).join('')}</ul>`:'<p class="score-empty">当天没有审核通过的任务</p>';
      return `<section class="score-person"><header><h4>${esc(names[member])}</h4><strong>${row.completed_count||0} 项 · ${formatPoints(row.points||0)} 点</strong></header>${list}${row.unscored_count?`<p class="score-warning">${row.unscored_count} 项历史任务未记录最终分数</p>`:''}</section>`;
    }).join('');
    return `<details class="daily-score-day"${date===currentDate?' open':''}><summary><span><b>${esc(date)}</b>${date===currentDate?'<small>今天</small>':''}</span><strong>${totalTasks} 项 · ${formatPoints(totalPoints)} 点</strong></summary><p class="score-rule">大任务只负责归类与汇总，不单独计分；下列小任务的最终得分只相加一次。${unscored?`另有 ${unscored} 项历史任务未记录分数。`:''}</p><div class="daily-score-people">${people}</div></details>`;
  }).join('');
  const firstDates=[...new Set(firstRows.map(row=>row.date))].reverse();
  document.querySelector('#score-history').innerHTML='<table><thead><tr><th>日期</th>'+Object.values(names).map(name=>'<th>'+esc(name)+'</th>').join('')+'</tr></thead><tbody>'+firstDates.map(date=>'<tr><th>'+date+'</th>'+Object.keys(names).map(member=>{const row=firstRows.find(item=>item.date===date&&item.assignee===member)||{points:0,unscored_count:0};return '<td>'+formatPoints(row.points)+' 点'+(row.unscored_count?'（'+row.unscored_count+' 项首次分数未记录）':'')+'</td>';}).join('')+'</tr>').join('')+'</tbody></table>';
}
async function ownerApi(path,data){
  const response=await fetch('api/employee/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Team-Request':'employee'},body:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'操作失败');return result;
}
function appendAiMessage(role,content){
  const article=document.createElement('article');
  article.className=`ai-message ${role}`;
  const label=document.createElement('span');
  label.textContent=role==='assistant'?'AI 分析助手':'你';
  const copy=document.createElement('p');
  copy.textContent=content;
  article.append(label,copy);
  const messages=document.querySelector('#ai-messages');
  messages.append(article);
  messages.scrollTop=messages.scrollHeight;
  return article;
}
function resetAiChat(){
  aiMessages=[];
  aiPeriod='today';
  document.querySelector('#ai-messages').innerHTML='<article class="ai-message assistant"><span>AI 分析助手</span><p>请选择“分析今日情况”或“分析近一周情况”，也可以直接输入你关心的问题。</p></article>';
  document.querySelector('#ai-chat-status').textContent='';
  document.querySelector('#ai-chat-input').value='';
}
function setAiBusy(busy){
  aiBusy=busy;
  document.querySelectorAll('[data-ai-prompt],#ai-chat-form textarea,#ai-chat-form button,#ai-new-chat').forEach(control=>{
    control.disabled=busy||!ownerLoggedIn;
  });
}
async function askAi(question,period=aiPeriod){
  const value=String(question||'').trim();
  if(!ownerLoggedIn){document.querySelector('#ai-chat-status').textContent='请先点击左侧“登录负责人并启用对话”。';return false;}
  if(!value)return false;
  aiPeriod=period;
  aiMessages.push({role:'user',content:value});
  const pendingMessage=appendAiMessage('user',value);
  const status=document.querySelector('#ai-chat-status');
  status.textContent=`正在读取${period==='week'?'近 7 天':'今日'}看板并分析…`;
  setAiBusy(true);
  try{
    const result=await ownerApi('analysis-chat',{period,messages:aiMessages.slice(-9)});
    aiMessages.push({role:'assistant',content:result.answer});
    if(aiMessages.length>8)aiMessages=aiMessages.slice(-8);
    appendAiMessage('assistant',result.answer);
    status.textContent=`已依据${period==='week'?'近 7 天':'今日'}最新记录完成分析。`;
    return true;
  }catch(error){
    aiMessages.pop();
    pendingMessage.remove();
    status.textContent=error.message;
    return false;
  }finally{setAiBusy(false);}
}
function updateOwnerControls(){
  document.querySelector('#owner-login').hidden=ownerLoggedIn;
  document.querySelector('#insert-task').hidden=!ownerLoggedIn;
  document.querySelector('#data-freeze-form').hidden=!ownerLoggedIn;
  document.querySelector('#owner-identity').textContent=ownerLoggedIn?'管理员：余文浩（已登录）':'余文浩登录后自动启用管理员权限。';
  document.querySelector('#ai-auth-gate').hidden=ownerLoggedIn;
  document.querySelector('#ai-access-note').textContent=ownerLoggedIn?'已登录；AI 每次都会读取所选范围的最新记录。':'登录负责人身份后可开始分析。';
  setAiBusy(aiBusy);
}
async function enableOwnerSession(){
  const result=await ownerApi('login',{name:names.YWH});
  ownerLoggedIn=Boolean(result.is_admin);
  updateOwnerControls();
  return ownerLoggedIn;
}
async function restoreOwnerSession(){
  try{
    const response=await fetch('api/employee/me',{cache:'no-store'});
    if(!response.ok)throw Error('未登录');
    const data=await response.json();
    ownerLoggedIn=Boolean(data.is_admin);
  }catch{
    ownerLoggedIn=false;
  }
  updateOwnerControls();
}
function appendReviewForm(t){
  if(t.status!=='待验收')return;
  const container=document.querySelector('#detail-side')||document.querySelector('#detail-content');
  if(!ownerLoggedIn){container.insertAdjacentHTML('beforeend','<p class="panel-hint">请先在页面下方登录负责人身份，再进行审核。</p>');return;}
  const employeeScore=t.employee_ai_points==null?'未填写':t.employee_ai_points+' 点';
  container.insertAdjacentHTML('beforeend','<form id="review-form"><p class="panel-hint">员工自评分：<strong>'+esc(employeeScore)+'</strong>。直接通过验收将采用该分数。</p><button type="button" id="override-score" class="secondary">覆盖分数</button><div id="override-score-field" hidden><label>覆盖后的最终分数（整数，0 也算）<input name="points" type="number" min="0" max="10000" step="1" placeholder="填写要覆盖的最终分数"></label></div><label>审核说明（退回必填）<textarea name="reason" maxlength="1200" placeholder="时间不符需自述"></textarea></label><label for="review-files">审核附件（可选）</label><input id="review-files" type="file" accept="*/*" multiple><p class="panel-hint">可附验收截图、修改要求示例等证据。最多 6 个，单个不超过 20 MB，合计不超过 40 MB。</p><div id="review-file-previews" class="archive-previews"></div><p id="review-file-status" role="status"></p><div class="review-actions"><button type="button" id="platform-score">生成平台 AI 建议</button><button name="decision" value="accept">通过验收</button><button name="decision" value="rework">退回修改</button></div><p id="review-notice" role="status"></p></form>');
  reviewFiles=[];renderReviewFiles();
  document.querySelector('#review-files').onchange=event=>{const files=[...event.target.files];event.target.value='';addReviewFiles(files);};
  document.querySelector('#review-file-previews').onclick=event=>{const button=event.target.closest('[data-remove-review-file]');if(!button)return;reviewFiles.splice(Number(button.dataset.removeReviewFile),1);renderReviewFiles();};
  const form=document.querySelector('#review-form');
  document.querySelector('#override-score').onclick=()=>{const field=document.querySelector('#override-score-field'),input=form.elements.points;field.hidden=!field.hidden;if(!field.hidden)input.focus();};
  form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form)),decision=e.submitter.value;const note=document.querySelector('#review-notice');const overrideVisible=!document.querySelector('#override-score-field').hidden;if(decision==='accept'&&overrideVisible&&data.points===''){note.textContent='请填写覆盖后的最终分数，可以为 0。';return;}const reason=decision==='rework'&&!data.reason.trim()?DEFAULT_REWORK_REASON:data.reason;form.querySelectorAll('button').forEach(b=>b.disabled=true);try{document.querySelector('#review-file-status').textContent=reviewFiles.length?'正在读取附件，请稍候…':'';const attachments=await Promise.all(reviewFiles.map(item=>readReviewFile(item.file)));const args={task_id:t.id,decision,reason,attachments};if(decision==='accept'&&overrideVisible)args.points=Number(data.points);await ownerApi('action',{action:'owner_review_task',args});reviewFiles=[];document.querySelector('#task-detail').close();await loadDashboard();}catch(error){note.textContent=error.message;}finally{form.querySelectorAll('button').forEach(b=>b.disabled=false);}};
  document.querySelector('#platform-score').onclick=async e=>{const button=e.currentTarget;button.disabled=true;const note=document.querySelector('#review-notice');note.textContent='正在生成建议，不影响你的最终打分…';try{const r=await ownerApi('score',{task_id:t.id});note.textContent='平台 AI 建议：'+r.points+' 点。'+r.reason;await loadDashboard();}catch(error){note.textContent=error.message;}finally{button.disabled=false;}};
}
function appendScoreEditForm(t){
  if(!ownerLoggedIn||t.status!=='已完成')return;
  const container=document.querySelector('#detail-side');
  container.insertAdjacentHTML('beforeend','<section class="score-edit-panel"><h3>调整最终得分</h3><p class="panel-hint">当前 '+esc(t.awarded_points==null?'尚未录入':t.awarded_points+' 点')+'。调整会保留完成日期，并写入任务记录。</p><form id="score-adjust-form"><label>最终得分（0–10000 整数）<input name="points" type="number" min="0" max="10000" step="1" required value="'+esc(t.awarded_points==null?'':t.awarded_points)+'"></label><label>调整原因<textarea name="reason" rows="3" maxlength="1200" required placeholder="说明本次分数调整原因"></textarea></label><button class="primary" type="submit">保存得分调整</button><p id="score-adjust-notice" role="status" aria-live="polite"></p></form></section>');
  const form=document.querySelector('#score-adjust-form');
  form.onsubmit=async event=>{
    event.preventDefault();
    const data=Object.fromEntries(new FormData(form));
    const score=Number(data.points),reason=data.reason.trim();
    const notice=document.querySelector('#score-adjust-notice');
    if(!Number.isInteger(score)||score<0||score>10000){notice.textContent='得分必须是 0–10000 的整数。';return;}
    if(!reason){notice.textContent='请填写调整原因。';return;}
    const button=form.querySelector('button[type="submit"]');button.disabled=true;
    try{
      await ownerApi('action',{action:'owner_set_task_score',args:{task_id:t.id,points:score,reason}});
      document.querySelector('#task-detail').close();
      await loadDashboard();
      showDetail(t.id);
    }catch(error){notice.textContent=error.message;button.disabled=false;}
  };
}
function appendCloseTaskForm(t){
  if(!ownerLoggedIn||!['阻塞','需修改'].includes(t.status))return;
  const container=document.querySelector('#detail-side');
  container.insertAdjacentHTML('beforeend','<section class="close-task-panel"><h3>关闭任务</h3><p class="panel-hint">关闭后任务会移到“关闭任务”，并从员工待办中移除。</p><label>关闭说明（可选）<textarea id="owner-close-reason" maxlength="1200" rows="3" placeholder="记录关闭原因"></textarea></label><button type="button" id="owner-close-task">确认关闭任务</button><p id="owner-close-notice" role="status"></p></section>');
  document.querySelector('#owner-close-task').onclick=async event=>{
    const button=event.currentTarget;
    if(!confirm(`确认关闭“${t.title}”？`))return;
    button.disabled=true;
    try{
      const reason=document.querySelector('#owner-close-reason').value.trim();
      await ownerApi('action',{action:'owner_close_task',args:{task_id:t.id,reason}});
      document.querySelector('#task-detail').close();
      await loadDashboard();
      showPage('closed',true);
    }catch(error){
      document.querySelector('#owner-close-notice').textContent=error.message;
      button.disabled=false;
    }
  };
}
function readReviewFile(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(Error('无法读取文件：'+file.name));reader.onload=()=>resolve({name:file.name,data:typeof reader.result==='string'?reader.result.split(',')[1]:'',contentType:file.type||'application/octet-stream'});reader.readAsDataURL(file);});}
function renderReviewFiles(){const target=document.querySelector('#review-file-previews');if(!target)return;target.innerHTML=reviewFiles.map((item,index)=>'<div class="archive-preview"><span aria-hidden="true">▣</span><strong>'+esc(item.file.name||'附件')+'</strong><small>'+formatReviewFileSize(item.file.size)+'</small><button type="button" data-remove-review-file="'+index+'">移除</button></div>').join('');}
function formatReviewFileSize(size){return size<1024*1024?Math.max(1,Math.round(size/1024))+' KB':(size/1024/1024).toFixed(1)+' MB';}
function addReviewFiles(files){const status=document.querySelector('#review-file-status');if(reviewFiles.length+files.length>6){status.textContent='每次最多上传 6 个文件。';return;}if(files.some(file=>!file.size||file.size>20*1024*1024)){status.textContent='文件不能为空，且单个不能超过 20 MB。';return;}if([...reviewFiles.map(item=>item.file),...files].reduce((sum,file)=>sum+file.size,0)>40*1024*1024){status.textContent='文件合计不能超过 40 MB。';return;}reviewFiles.push(...files.map(file=>({file})));renderReviewFiles();status.textContent='已选 '+reviewFiles.length+' / 6 个文件';}
document.querySelector('#owner-login').onsubmit=async e=>{e.preventDefault();const note=document.querySelector('#owner-notice');try{const data=Object.fromEntries(new FormData(e.target));if(data.name.trim()!==names.YWH)throw Error('此处仅供管理员余文浩登录，员工请使用员工工作台。');await enableOwnerSession();note.textContent='已登录，可以冻结历史数据、插单、审核打分和关闭阻塞/需修改任务。';}catch(error){note.textContent=error.message;}};
document.querySelector('#ai-owner-login').onclick=async event=>{
  const button=event.currentTarget,status=document.querySelector('#ai-chat-status');
  button.disabled=true;status.textContent='正在启用负责人会话…';
  try{await enableOwnerSession();status.textContent='已启用，可以直接提问。';document.querySelector('#ai-chat-input').focus();}
  catch(error){status.textContent=error.message;button.disabled=false;}
};
document.querySelectorAll('[data-ai-prompt]').forEach(button=>button.onclick=()=>{
  const period=button.dataset.aiPrompt;
  resetAiChat();
  askAi(period==='week'?'请分析近 7 天团队情况，先给总体结论，再说明每个人的产出与负载、主要风险、趋势，以及我下一步最该做的三件事。':'请分析今日团队情况，先给总体结论，再说明每个人当前在做什么、完成与待验收情况、阻塞或返工风险，以及我今天最该介入的事项。',period);
});
document.querySelector('#ai-chat-form').onsubmit=async event=>{
  event.preventDefault();
  const input=document.querySelector('#ai-chat-input');
  const question=input.value.trim();
  if(!question)return;
  input.value='';
  const sent=await askAi(question);
  if(!sent){input.value=question;input.focus();}
};
document.querySelector('#ai-chat-input').onkeydown=event=>{
  if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();document.querySelector('#ai-chat-form').requestSubmit();}
};
document.querySelector('#ai-new-chat').onclick=resetAiChat;
document.querySelector('#insert-task').onsubmit=async e=>{e.preventDefault();const form=e.target,button=form.querySelector('button'),note=document.querySelector('#owner-notice');button.disabled=true;try{const args=Object.fromEntries(new FormData(form));args.estimated_minutes=Number(args.estimated_minutes);const result=await ownerApi('action',{action:'owner_insert_task',args});note.textContent=result.message;form.reset();await loadDashboard();}catch(error){note.textContent=error.message;}finally{button.disabled=false;}};
document.querySelector('#data-freeze-form').onsubmit=async event=>{
  event.preventDefault();
  const form=event.currentTarget,button=form.querySelector('button'),notice=document.querySelector('#data-freeze-notice');
  const freezeDate=form.elements.freeze_date.value;
  if(!freezeDate)return;
  if(!confirm(`确认把数据起始日设为 ${freezeDate}？更早的任务、计时、HB、日报、附件和得分将从所有工作台及 AI 分析中隐藏。`))return;
  button.disabled=true;notice.textContent='正在保存冻结日期…';
  try{
    const result=await ownerApi('freeze',{freeze_date:freezeDate});
    await loadDashboard();
    notice.textContent=result.message;
  }catch(error){notice.textContent=error.message;}
  finally{button.disabled=false;}
};
let loading=false;
async function loadDashboard(){
  if(loading)return;loading=true;const button=document.querySelector('#refresh-dashboard');button.disabled=true;
  try{await refresh();await restoreOwnerSession();document.querySelector('#load-error').hidden=true;document.querySelector('#sync-status').textContent='更新于 '+clock(Date.now());}
  catch(error){const target=document.querySelector('#load-error');target.hidden=false;target.textContent='更新失败，已保留上次数据。请点击“刷新数据”重试。';document.querySelector('#sync-status').textContent='数据未更新';}
  finally{loading=false;button.disabled=false;}
}
document.querySelector('#refresh-dashboard').onclick=loadDashboard;
loadDashboard();
updatePomodoro();
setInterval(updatePomodoro,1000);
setInterval(loadDashboard,30000);
