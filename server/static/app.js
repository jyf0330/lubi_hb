let dashboardGroups = [];
let dashboardScores = [];
let dashboardProgress = [];
let dashboardDate = "";
let dashboardApiRoot = null;
let ownerLoggedIn = false;
const statuses = ["今日待办", "进行中", "待验收", "需修改", "已完成", "阻塞"];
const names = { ZHC: "赵浩丞", YWT: "余文滔", YWH: "余文浩" };
const WORK_SECONDS = 25 * 60;
const REST_SECONDS = 5 * 60;
const CYCLE_SECONDS = WORK_SECONDS + REST_SECONDS;
let reminderSoundEnabled = false;
let previousPomodoroPhase = null;
let pendingReworkKey = null;
let reviewFiles = [];
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
    return `${timing(t)} · ${t.submitted_at ? clock(t.submitted_at) + " 提交" : "等待检查"}`;
  if (t.status === "已完成") return `验收通过 · ${timing(t)}`;
  return `${t.type} · 预计 ${t.estimated_minutes} 分钟${t.overdue ? " · 已延期" : ""}`;
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
  dashboardDate = data.date;
  renderScoreHistory();
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
      planned = own.filter(t=>t.planned_date===data.date).reduce((a, t) => a + Number(t.planned_points), 0),
      done = dashboardScores.find(r=>r.date===data.date&&r.assignee===id)?.points || 0;
    return { id, own, active, session, planned, done };
  });
  const planned = people.reduce((a, p) => a + p.planned, 0),
    done = people.reduce((a, p) => a + p.done, 0),
    waiting = tasks.filter((t) => t.status === "待验收"),
    blocked = tasks.filter((t) => t.status === "阻塞"),
    active = people.filter(p=>p.own.some(t=>t.status==='进行中'&&!t.is_paused)).length,
    low = people.filter((p) => p.planned < 6).map((p) => p.id),
    overrun = tasks.filter((t) => t.effort_status === "超出预估"),
    overdue = tasks.filter((t) => t.overdue),
    checkinDue = people.filter((p) => p.active?.checkin?.due);
  document.querySelector("#planned").textContent = `${tasks.filter(t=>t.status!=='已完成').length} 项`;
  document.querySelector("#done").textContent = `${done} 点`;
  document.querySelector("#rate").textContent =
    "点击查看任务明细 →";
  document.querySelector("#review-count").textContent = `${waiting.length} 项`;
  document.querySelector("#blocked-count").textContent = `${blocked.length} 项`;
  document.querySelector("#brief-title").textContent =
    `${active} 人正在执行任务，${blocked.length ? `${blocked.length} 项阻塞` : "当前无阻塞"}`;
  document.querySelector("#brief-copy").textContent =
    `${tasks.filter(t=>t.priority==='高').length} 项高优先临时插单，${waiting.length} 项等待你审核打分。员工可自行暂停或并行。`;
  document.querySelector("#people").innerHTML = [...people].sort((a,b)=>Number(Boolean(b.session))-Number(Boolean(a.session)))
    .map((p) => {
      const remaining = Math.max(0, p.planned - p.done),
        pct = p.planned
          ? Math.min(100, Math.round((p.done / p.planned) * 100))
          : 0,
        checkin = checkinMeta(p.active);
      const tag = p.active ? "button" : "article",
        action = p.active
          ? ` type="button" data-person-task-id="${esc(p.active.id)}" aria-label="查看 ${esc(names[p.id])} 的任务详情"`
          : "",
        actionClass = p.active ? " person-action" : "";
      return `<${tag} class="person ${p.id.toLowerCase()}${actionClass}"${action}><div class="person-top"><div class="avatar">${p.id}</div><div><small>${esc(names[p.id])}</small><h3>${p.active?.priority==='高'?'高优先 · ':''}${esc(p.active?.title || "当前没有进行中的任务")}</h3><p>${p.session ? `${esc(p.active.type)} · ${clock(p.session.started_at)} 开始` : p.active?.status==='待验收'?"等待审核 · 已停止计时":p.active?"当前未计时":"尚未开始计时"}</p></div><span class="state">${p.active?.is_paused ? "已暂停" : esc(p.active?.status || "未记录")}</span></div>${checkin ? `<div class="checkin ${checkin.due ? "due" : "ok"}"><strong>${esc(checkin.label)}</strong><span>${esc(checkin.detail)}</span></div>` : ""}<div class="bar-copy"><span>今日审核得分 ${p.done} 点</span><span>近 7 天 ${dashboardScores.filter(r=>r.assignee===p.id).reduce((n,r)=>n+r.points,0)} 点</span></div><p>正在计时 ${p.own.filter(t=>t.status==='进行中'&&!t.is_paused).length} 项${p.active?.priority==='高'?' · 高优先通常两小时以内':''}</p>${p.active ? '<span class="person-detail-link">查看任务详情 →</span>' : ""}</${tag}>`;
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
    ? pendingAcceptance
        .map(
          (task) =>
            `<button type="button" class="action progress-pending-task" data-task-id="${esc(task.id)}"><span class="status-badge status-2">待验收</span><strong>${esc(task.title)}</strong><span>${esc(names[task.assignee] || task.assignee)} · ${esc(meta(task))}</span><span class="detail-link">查看详情 →</span></button>`,
        )
        .join("")
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
  renderTasks();
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
  document.querySelector("#sessions").innerHTML = ["ZHC", "YWT"]
    .map((id) => {
      const ownSessions = sessions.filter((session) => session.assignee === id);
      return `<section class="timeline-column ${id.toLowerCase()}">
        <header class="timeline-column-heading">
          <span class="timeline-person-mark">${id}</span>
          <div><strong>${esc(names[id] || id)}</strong><span>${ownSessions.length} 条记录</span></div>
        </header>
        <div class="timeline-session-list">${ownSessions.length
          ? ownSessions
              .map(
                (s) =>
                  `<article class="timeline-session ${s.ended_at ? "done" : "active"}"><div class="timeline-session-meta"><time>${clock(s.started_at)}</time><span>${s.ended_at ? "已结束" : "进行中"}</span></div><div class="timeline-task"><span></span><strong>${esc(s.title)} · ${s.ended_at ? `有效工时 ${s.recorded_minutes} 分钟` : `已记录 ${s.recorded_minutes} 分钟`}</strong></div></article>`,
              )
              .join("")
          : '<div class="empty-timeline">今日暂无计时记录</div>'}</div>
      </section>`;
    })
    .join("");
  const actions = tasks.filter((t) =>
    ["待验收", "需修改", "阻塞"].includes(t.status),
  );
  document.querySelector("#action-count").textContent = actions.length;
  const taskById = new Map(actions.map((task) => [task.id, task]));
  const groupedActionIds = new Set();
  const groupedActions = dashboardGroups
    .map((group) => ({
      group,
      tasks: group.tasks.map((child) => taskById.get(child.id)).filter(Boolean),
    }))
    .filter(({ tasks }) => tasks.length)
    .map(({ group, tasks }) => {
      tasks.forEach((task) => groupedActionIds.add(task.id));
      return renderActionGroup(group, tasks);
    });
  const standaloneActions = actions
    .filter((task) => !groupedActionIds.has(task.id))
    .map((task) => renderActionCard(task));
  document.querySelector("#actions").innerHTML = actions.length
    ? [...groupedActions, ...standaloneActions].join("")
    : '<div class="empty">当前无需处理</div>';
}
let dashboardTasks = [];
const pages = ['overview','board','progress','daily','timeline'];
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
function renderActionGroup(group, tasks){
  return `<article class="action action-group"><div class="action-group-heading"><span class="action-group-label">大任务</span><strong>${esc(group.title)}</strong><span>${esc(names[group.assignee]||group.assignee)} · ${esc(group.status)} · ${tasks.length} / ${group.total_count} 个小任务需处理</span></div><details class="action-group-details" open><summary>查看需处理的小任务</summary><div class="action-group-children">${tasks.map(t=>renderActionCard(t,true)).join('')}</div></details></article>`;
}
function taskMatchesFilters(t, filters){
  return (!filters.owner||t.assignee===filters.owner)&&(!filters.status||t.status===filters.status)&&(!filters.date||t.planned_date===filters.date)&&(!filters.search||(t.title+' '+(t.group_title||'')).toLowerCase().includes(filters.search));
}
function renderTasks(){
  const filters={owner:document.querySelector('#owner-filter').value,status:document.querySelector('#status-filter').value,date:document.querySelector('#date-filter').value,search:document.querySelector('#task-search').value.trim().toLowerCase()};
  const rank={'待验收':0,'阻塞':1,'需修改':2,'进行中':3,'今日待办':4,'已完成':5};
  const list=dashboardTasks.filter(t=>taskMatchesFilters(t,filters)).sort((a,b)=>Number(b.priority==='高')-Number(a.priority==='高')||rank[a.status]-rank[b.status]);
  document.querySelector('#task-total').textContent=`显示 ${list.length} / ${dashboardTasks.length} 项`;
  document.querySelector('#task-groups').innerHTML=dashboardGroups.filter(g=>(!filters.owner||g.assignee===filters.owner)&&(!filters.status||g.status===filters.status)&&(!filters.search||(g.title+' '+g.tasks.map(t=>t.title).join(' ')).toLowerCase().includes(filters.search))&&(!filters.date||g.tasks.some(t=>t.planned_date===filters.date))).map(g=>`<article class="group-summary"><strong>${esc(g.title)}</strong><p>${esc(names[g.assignee]||g.assignee)} · ${esc(g.status)} · 验收通过 ${g.completed_count}/${g.total_count} 项 · ${g.stated_minutes==null?'未填写大任务参考时间':'大任务参考 '+g.stated_minutes+' 分钟'} · 小任务合计 ${g.estimated_minutes} 分钟 · 已记录 ${g.actual_minutes} 分钟</p><details><summary>交付与验收要求</summary><p>${esc(g.deliverable_expectation)}</p><p>${esc(g.acceptance_criteria)}</p></details></article>`).join('');
  document.querySelector('#kanban').innerHTML=list.length?list.map(t=>`<button type="button" class="task task-row" data-task-id="${esc(t.id)}"><span class="task-main"><strong>${t.priority==='高'?'高优先 · ':''}${esc(t.title)}</strong>${t.group_title?`<span class="task-meta">所属大任务：${esc(t.group_title)}</span>`:''}<span class="task-meta">${esc(names[t.assignee]||t.assignee||'未指派')} · ${esc(t.planned_date?`计划 ${t.planned_date}`:'未排期')} · ${esc(meta(t))}</span></span><span class="status-badge status-${statuses.indexOf(t.status)}">${esc(t.is_paused?'已暂停':t.status)}</span><span class="detail-link">查看详情 →</span></button>`).join(''):'<div class="empty">没有符合条件的任务，可调整或清除筛选。</div>';
}
for(const id of ['owner-filter','status-filter','date-filter','task-search'])document.getElementById(id).addEventListener('input',renderTasks);
document.querySelector('#clear-filters').onclick=()=>{for(const id of ['owner-filter','status-filter','date-filter','task-search'])document.getElementById(id).value='';renderTasks();};
document.querySelectorAll('[data-status-jump]').forEach(button=>button.onclick=()=>{
  document.querySelector('#status-filter').value=button.dataset.statusJump;document.querySelector('#owner-filter').value='';document.querySelector('#date-filter').value='';document.querySelector('#task-search').value='';renderTasks();showPage('board',true);
});
function showDetail(id){
  const t=dashboardTasks.find(t=>t.id===id);if(!t)return;
  let appendReason='';if(t.notes){try{appendReason=JSON.parse(t.notes).append_reason||'';}catch{}}
  const fields=[['所属大任务',t.group_title],['负责人',names[t.assignee]||t.assignee||'未指派'],['状态',t.is_paused?'已暂停':t.status],['用时',timing(t)],['用时详情',timeDetails(t)],['交付内容',t.deliverable_expectation],['验收标准',t.acceptance_criteria],['优先级',t.priority==='高'?'高优先 · 负责人临时插单':'正常'],['完成说明',t.result_summary],['补充原因',appendReason],['员工自评分',t.employee_ai_points==null?'未填写':t.employee_ai_points+' 点'+(t.employee_ai_reason?' · '+t.employee_ai_reason:'')],['平台 AI 建议',t.platform_ai_points==null?'尚未生成':t.platform_ai_points+' 点 · '+t.platform_ai_reason],['最终得分',t.awarded_points==null?'未打分':t.awarded_points+' 点'],['验收结果',t.acceptance_result],['阻塞原因',t.blocked_reason]];
  const shortLabels=new Set(['所属大任务','负责人','状态','用时','优先级','员工自评分','最终得分']);
  const items=fields.filter(([,v])=>v!==null&&v!==undefined&&v!=='');
  const chips=items.filter(([label])=>shortLabels.has(label)).map(([label,value])=>'<span class="detail-chip"><b>'+label+'</b>'+esc(value)+'</span>').join('');
  const details=items.filter(([label])=>!shortLabels.has(label)).map(([label,value])=>'<div class="detail-field"><dt>'+label+'</dt><dd>'+esc(value)+'</dd></div>').join('');
  const canReview=t.status==='待验收';
  const content=document.querySelector('#detail-content');
  content.classList.toggle('has-review',canReview);
  content.innerHTML='<section class="detail-main"><h3>'+esc(t.title)+'</h3>'+(chips?'<div class="detail-chips">'+chips+'</div>':'')+(details?'<dl class="detail-fields">'+details+'</dl>':'')+taskAttachmentGallery(t.attachments, dashboardApiRoot)+'</section>'+(canReview?'<aside class="detail-side" id="detail-side"></aside>':'');
  appendReviewForm(t);
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
for(const id of ['kanban','actions','progress-pending'])document.getElementById(id).onclick=e=>{const button=e.target.closest('[data-task-id]');if(button)showDetail(button.dataset.taskId);};
document.querySelector('#people').onclick=e=>{const card=e.target.closest('[data-person-task-id]');if(card)showDetail(card.dataset.personTaskId);};
document.querySelector('#close-detail').onclick=()=>document.querySelector('#task-detail').close();
function showScoreDetail(){
  const tasks=dashboardTasks
    .filter(t=>t.status==='已完成'&&t.completed_at&&shanghaiDate(t.completed_at)===dashboardDate)
    .sort((a,b)=>Number(b.completed_at)-Number(a.completed_at));
  const total=tasks.reduce((sum,t)=>sum+(t.awarded_points==null?0:Number(t.awarded_points)),0);
  const scored=tasks.filter(t=>t.awarded_points!=null).length;
  const grouped=['ZHC','YWT','YWH'].map(member=>({
    member,
    tasks:tasks.filter(t=>t.assignee===member),
  })).filter(group=>group.tasks.length);
  const groups=grouped.map(group=>{
    const points=group.tasks.reduce((sum,t)=>sum+(t.awarded_points==null?0:Number(t.awarded_points)),0);
    return `<section class="score-person"><header><h3>${esc(names[group.member]||group.member)}</h3><strong>${group.tasks.length} 项 · ${formatPoints(points)} 点</strong></header><ul>${group.tasks.map(t=>`<li><span><b>${esc(t.title)}</b><small>${clock(t.completed_at)} 审核通过${t.awarded_points==null?' · 尚未记录最终分数':''}</small></span><strong class="score-value">${t.awarded_points==null?'未打分':formatPoints(t.awarded_points)+' 点'}</strong></li>`).join('')}</ul></section>`;
  }).join('');
  document.querySelector('#score-detail-content').innerHTML=`<div class="score-summary"><div><small>今日审核任务</small><strong>${tasks.length} 项</strong></div><div><small>已记录分数</small><strong>${scored} / ${tasks.length} 项</strong></div><div><small>今日总得分</small><strong>${formatPoints(total)} 点</strong></div></div>${groups||'<div class="empty">今天还没有审核通过的任务。</div>'}`;
  document.querySelector('#score-detail').showModal();
}
document.querySelector('[data-score-details]').onclick=showScoreDetail;
document.querySelector('#close-score-detail').onclick=()=>document.querySelector('#score-detail').close();
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
function renderScoreHistory(){
  const dates=[...new Set(dashboardScores.map(r=>r.date))].reverse();
  document.querySelector('#score-history').innerHTML='<table><thead><tr><th>日期</th>'+Object.values(names).map(n=>'<th>'+esc(n)+'</th>').join('')+'</tr></thead><tbody>'+dates.map(date=>'<tr><th>'+date+'</th>'+Object.keys(names).map(member=>{const row=dashboardScores.find(r=>r.date===date&&r.assignee===member);return '<td>'+row.points+' 点'+(row.unscored_count?'（'+row.unscored_count+' 项旧任务未打分）':'')+'</td>';}).join('')+'</tr>').join('')+'</tbody></table>';
}
async function ownerApi(path,data){
  const response=await fetch('api/employee/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Team-Request':'employee'},body:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw Error(result.error||'操作失败');return result;
}
function updateOwnerControls(){
  document.querySelector('#owner-login').hidden=ownerLoggedIn;
  document.querySelector('#insert-task').hidden=!ownerLoggedIn;
  document.querySelector('#owner-identity').textContent=ownerLoggedIn?'管理员：余文浩（已登录）':'余文浩登录后自动启用管理员权限。';
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
function readReviewFile(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(Error('无法读取文件：'+file.name));reader.onload=()=>resolve({name:file.name,data:typeof reader.result==='string'?reader.result.split(',')[1]:'',contentType:file.type||'application/octet-stream'});reader.readAsDataURL(file);});}
function renderReviewFiles(){const target=document.querySelector('#review-file-previews');if(!target)return;target.innerHTML=reviewFiles.map((item,index)=>'<div class="archive-preview"><span aria-hidden="true">▣</span><strong>'+esc(item.file.name||'附件')+'</strong><small>'+formatReviewFileSize(item.file.size)+'</small><button type="button" data-remove-review-file="'+index+'">移除</button></div>').join('');}
function formatReviewFileSize(size){return size<1024*1024?Math.max(1,Math.round(size/1024))+' KB':(size/1024/1024).toFixed(1)+' MB';}
function addReviewFiles(files){const status=document.querySelector('#review-file-status');if(reviewFiles.length+files.length>6){status.textContent='每次最多上传 6 个文件。';return;}if(files.some(file=>!file.size||file.size>20*1024*1024)){status.textContent='文件不能为空，且单个不能超过 20 MB。';return;}if([...reviewFiles.map(item=>item.file),...files].reduce((sum,file)=>sum+file.size,0)>40*1024*1024){status.textContent='文件合计不能超过 40 MB。';return;}reviewFiles.push(...files.map(file=>({file})));renderReviewFiles();status.textContent='已选 '+reviewFiles.length+' / 6 个文件';}
document.querySelector('#owner-login').onsubmit=async e=>{e.preventDefault();const note=document.querySelector('#owner-notice');try{const data=Object.fromEntries(new FormData(e.target));if(data.name.trim()!==names.YWH)throw Error('此处仅供管理员余文浩登录，员工请使用员工工作台。');const r=await ownerApi('login',data);ownerLoggedIn=Boolean(r.is_admin);updateOwnerControls();note.textContent='已登录，可以插单和打开待验收任务打分。';}catch(error){note.textContent=error.message;}};
document.querySelector('#insert-task').onsubmit=async e=>{e.preventDefault();const form=e.target,button=form.querySelector('button'),note=document.querySelector('#owner-notice');button.disabled=true;try{const args=Object.fromEntries(new FormData(form));args.estimated_minutes=Number(args.estimated_minutes);const result=await ownerApi('action',{action:'owner_insert_task',args});note.textContent=result.message;form.reset();await loadDashboard();}catch(error){note.textContent=error.message;}finally{button.disabled=false;}};
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
