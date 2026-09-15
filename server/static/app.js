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
    "以负责人审核打分为准";
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
      return `<article class="person ${p.id.toLowerCase()}"><div class="person-top"><div class="avatar">${p.id}</div><div><small>${esc(names[p.id])}</small><h3>${p.active?.priority==='高'?'高优先 · ':''}${esc(p.active?.title || "当前没有进行中的任务")}</h3><p>${p.session ? `${esc(p.active.type)} · ${clock(p.session.started_at)} 开始` : p.active?.status==='待验收'?"等待审核 · 已停止计时":p.active?"当前未计时":"尚未开始计时"}</p></div><span class="state">${p.active?.is_paused ? "已暂停" : esc(p.active?.status || "未记录")}</span></div>${checkin ? `<div class="checkin ${checkin.due ? "due" : "ok"}"><strong>${esc(checkin.label)}</strong><span>${esc(checkin.detail)}</span></div>` : ""}<div class="bar-copy"><span>今日审核得分 ${p.done} 点</span><span>近 7 天 ${dashboardScores.filter(r=>r.assignee===p.id).reduce((n,r)=>n+r.points,0)} 点</span></div><p>正在计时 ${p.own.filter(t=>t.status==='进行中'&&!t.is_paused).length} 项${p.active?.priority==='高'?' · 高优先通常两小时以内':''}</p></article>`;
    })
    .join("");
  const progress = data.progress_updates || [];
  dashboardProgress = progress;
  dashboardApiRoot = new URL("api/", location.href);
  document.querySelector("#progress-count").textContent =
    `今日 ${progress.length} 次 · ${new Set(progress.map((item) => item.assignee)).size} 人`;
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
        <span class="progress-person-latest">${latest ? `<time>${clock(latest.created_at)}</time><b>${esc(latest.title)}</b><span>${esc(heartbeatText(latest))}</span>` : "点击查看该成员的详细工作记录"}</span>
        <span class="progress-person-foot">${screenshotCount ? `截图 ${screenshotCount} 张` : "暂无截图"}${latest?.next_step ? ` · 下一步：${esc(latest.next_step)}` : ""}</span>
      </button>`;
    })
    .join("");
  dashboardTasks = tasks;
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
  document.querySelector("#sessions").innerHTML = sessions.length
    ? sessions
        .slice(0, 12)
        .map(
          (s) =>
            `<div class="session"><time>${clock(s.started_at)}</time><span>${esc(names[s.assignee]||s.assignee)}</span><strong>${esc(s.title)} · ${s.ended_at ? `有效工时 ${s.recorded_minutes} 分钟` : `进行中 · 已记录 ${s.recorded_minutes} 分钟`}</strong></div>`,
        )
        .join("")
    : '<div class="empty">今日暂无计时记录</div>';
  const actions = tasks.filter((t) =>
    ["待验收", "需修改", "阻塞"].includes(t.status),
  );
  document.querySelector("#action-count").textContent = actions.length;
  document.querySelector("#actions").innerHTML = actions.length
    ? actions
        .map(
          (t) =>
            `<button type="button" class="action" data-task-id="${esc(t.id)}"><span class="status-badge status-${statuses.indexOf(t.status)}">${esc(t.status)}</span><strong>${esc(t.title)}</strong><span>${esc(names[t.assignee]||t.assignee)} · ${esc(meta(t))}</span><span class="detail-link">查看详情 →</span></button>`,
        )
        .join("")
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
function renderTasks(){
  const owner=document.querySelector('#owner-filter').value,status=document.querySelector('#status-filter').value,search=document.querySelector('#task-search').value.trim().toLowerCase();
  const rank={'待验收':0,'阻塞':1,'需修改':2,'进行中':3,'今日待办':4,'已完成':5};
  const list=dashboardTasks.filter(t=>(!owner||t.assignee===owner)&&(!status||t.status===status)&&(!search||(t.title+' '+t.group_title).toLowerCase().includes(search))).sort((a,b)=>Number(b.priority==='高')-Number(a.priority==='高')||rank[a.status]-rank[b.status]);
  document.querySelector('#task-total').textContent=`显示 ${list.length} / ${dashboardTasks.length} 项`;
  document.querySelector('#task-groups').innerHTML=dashboardGroups.filter(g=>(!owner||g.assignee===owner)&&(!status||g.status===status)&&(!search||(g.title+' '+g.tasks.map(t=>t.title).join(' ')).toLowerCase().includes(search))).map(g=>`<article class="group-summary"><strong>${esc(g.title)}</strong><p>${esc(names[g.assignee]||g.assignee)} · ${esc(g.status)} · 验收通过 ${g.completed_count}/${g.total_count} 项 · ${g.stated_minutes==null?'未填写大任务参考时间':'大任务参考 '+g.stated_minutes+' 分钟'} · 小任务合计 ${g.estimated_minutes} 分钟 · 已记录 ${g.actual_minutes} 分钟</p><details><summary>交付与验收要求</summary><p>${esc(g.deliverable_expectation)}</p><p>${esc(g.acceptance_criteria)}</p></details></article>`).join('');
  document.querySelector('#kanban').innerHTML=list.length?list.map(t=>`<button type="button" class="task task-row" data-task-id="${esc(t.id)}"><span class="task-main"><strong>${t.priority==='高'?'高优先 · ':''}${esc(t.title)}</strong>${t.group_title?`<span class="task-meta">所属大任务：${esc(t.group_title)}</span>`:''}<span class="task-meta">${esc(names[t.assignee]||t.assignee||'未指派')} · ${esc(meta(t))}</span></span><span class="status-badge status-${statuses.indexOf(t.status)}">${esc(t.is_paused?'已暂停':t.status)}</span><span class="detail-link">查看详情 →</span></button>`).join(''):'<div class="empty">没有符合条件的任务，可调整或清除筛选。</div>';
}
for(const id of ['owner-filter','status-filter','task-search'])document.getElementById(id).addEventListener('input',renderTasks);
document.querySelector('#clear-filters').onclick=()=>{for(const id of ['owner-filter','status-filter','task-search'])document.getElementById(id).value='';renderTasks();};
document.querySelectorAll('[data-status-jump]').forEach(button=>button.onclick=()=>{
  document.querySelector('#status-filter').value=button.dataset.statusJump;document.querySelector('#owner-filter').value='';document.querySelector('#task-search').value='';renderTasks();showPage('board',true);
});
function showDetail(id){
  const t=dashboardTasks.find(t=>t.id===id);if(!t)return;
  let appendReason='';if(t.notes){try{appendReason=JSON.parse(t.notes).append_reason||'';}catch{}}
  const fields=[['所属大任务',t.group_title],['负责人',names[t.assignee]||t.assignee||'未指派'],['状态',t.is_paused?'已暂停':t.status],['用时',timing(t)],['交付内容',t.deliverable_expectation],['验收标准',t.acceptance_criteria],['优先级',t.priority==='高'?'高优先 · 负责人临时插单':'正常'],['完成说明',t.result_summary],['补充原因',appendReason],['员工 AI 建议',t.employee_ai_points==null?'未提供':t.employee_ai_points+' 点 · '+t.employee_ai_reason],['平台 AI 建议',t.platform_ai_points==null?'尚未生成':t.platform_ai_points+' 点 · '+t.platform_ai_reason],['最终得分',t.awarded_points==null?'未打分':t.awarded_points+' 点'],['验收结果',t.acceptance_result],['阻塞原因',t.blocked_reason]];
  document.querySelector('#detail-content').innerHTML=`<h3>${esc(t.title)}</h3><dl>${fields.filter(([,v])=>v).map(([label,value])=>`<dt>${label}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
  appendReviewForm(t);
  document.querySelector('#task-detail').showModal();
}
for(const id of ['kanban','actions'])document.getElementById(id).onclick=e=>{const button=e.target.closest('[data-task-id]');if(button)showDetail(button.dataset.taskId);};
document.querySelector('#close-detail').onclick=()=>document.querySelector('#task-detail').close();
function showProgressDetail(assignee){
  const items = dashboardProgress.filter((item) => item.assignee === assignee);
  document.querySelector('#progress-detail-title').textContent = `${names[assignee] || assignee} · 今日汇报`;
  document.querySelector('#progress-detail-content').innerHTML = items.length
    ? items.map((item) => `<article class="progress-detail-item">
        <header><time>${clock(item.created_at)}</time><span class="progress-status">${esc(item.report_status || "进展")}</span></header>
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
  const container=document.querySelector('#detail-content');
  if(!ownerLoggedIn){container.insertAdjacentHTML('beforeend','<p>请先在页面下方登录负责人身份，再进行审核。</p>');return;}
  container.insertAdjacentHTML('beforeend','<form id="review-form"><label>最终点数<input name="points" type="number" min="0" max="10000" step="0.01" placeholder="由你最终打分"></label><label>审核说明（退回必填）<textarea name="reason" maxlength="1200"></textarea></label><div class="review-actions"><button type="button" id="platform-score">生成平台 AI 建议</button><button name="decision" value="accept">通过并计分</button><button name="decision" value="rework">退回修改</button></div><p id="review-notice" role="status"></p></form>');
  const form=document.querySelector('#review-form');
  form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form)),decision=e.submitter.value;const note=document.querySelector('#review-notice');if(decision==='accept'&&data.points===''){note.textContent='请填写最终点数，可以为 0。';return;}form.querySelectorAll('button').forEach(b=>b.disabled=true);try{await ownerApi('action',{action:'owner_review_task',args:{task_id:t.id,decision,points:Number(data.points),reason:data.reason}});document.querySelector('#task-detail').close();await loadDashboard();}catch(error){note.textContent=error.message;}finally{form.querySelectorAll('button').forEach(b=>b.disabled=false);}};
  document.querySelector('#platform-score').onclick=async e=>{const button=e.currentTarget;button.disabled=true;const note=document.querySelector('#review-notice');note.textContent='正在生成建议，不影响你的最终打分…';try{const r=await ownerApi('score',{task_id:t.id});note.textContent='平台 AI 建议：'+r.points+' 点。'+r.reason;await loadDashboard();}catch(error){note.textContent=error.message;}finally{button.disabled=false;}};
}
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
