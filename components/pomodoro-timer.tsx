'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellOff, Coffee, TimerReset } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TaskRow } from '@/lib/task-data';
import type { Member } from '@/lib/task-domain';

const WORK_SECONDS = 25 * 60;
const REST_SECONDS = 5 * 60;
const CYCLE_SECONDS = WORK_SECONDS + REST_SECONDS;
const SHANGHAI_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

type TimerPhase = 'work' | 'rest' | 'off';

type TimerState = {
  phase: TimerPhase;
  phaseKey: string;
  remainingSeconds: number;
  progress: number;
  nextLabel: string;
};

function shanghaiSeconds(date: Date) {
  const parts = Object.fromEntries(
    SHANGHAI_CLOCK.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return parts.hour * 3600 + parts.minute * 60 + parts.second;
}

function timerState(date: Date): TimerState {
  const seconds = shanghaiSeconds(date);
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
      phase: 'off',
      phaseKey: `off-${seconds < morningStart ? 'morning' : seconds < afternoonStart ? 'noon' : 'evening'}`,
      remainingSeconds: 0,
      progress: 0,
      nextLabel:
        seconds < morningStart
          ? '09:30 开始上班'
          : seconds < afternoonStart
            ? '14:00 继续上班'
            : '今日已下班 · 明日 09:30',
    };
  }

  const elapsed = seconds - windowStart;
  const cycleIndex = Math.floor(elapsed / CYCLE_SECONDS);
  const withinCycle = elapsed % CYCLE_SECONDS;
  const phase: TimerPhase = withinCycle < WORK_SECONDS ? 'work' : 'rest';
  const phaseElapsed =
    phase === 'work' ? withinCycle : withinCycle - WORK_SECONDS;
  const phaseDuration = phase === 'work' ? WORK_SECONDS : REST_SECONDS;

  return {
    phase,
    phaseKey: `${windowStart}-${cycleIndex}-${phase}`,
    remainingSeconds: phaseDuration - phaseElapsed,
    progress: phaseElapsed / phaseDuration,
    nextLabel: phase === 'work' ? '专注 25 分钟' : '休息 5 分钟',
  };
}

function formatCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function playReminder(kind: 'rest' | 'work' | 'rework') {
  const AudioContextClass = window.AudioContext;
  const context = new AudioContextClass();
  const master = context.createGain();
  const duration = kind === 'rework' ? 30 : 15;
  master.gain.setValueAtTime(0.0001, context.currentTime);
  master.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.04);
  master.gain.setValueAtTime(0.18, context.currentTime + duration - 0.2);
  master.gain.exponentialRampToValueAtTime(
    0.0001,
    context.currentTime + duration,
  );
  master.connect(context.destination);

  const notes =
    kind === 'rest'
      ? [880, 1174]
      : kind === 'work'
        ? [523, 659, 784, 1046]
        : [523, 659, 784, 659, 587, 698, 880, 698];
  const spacing = kind === 'rest' ? 1.5 : 0.5;
  const noteLength = kind === 'rest' ? 0.55 : 0.36;

  for (let offset = 0; offset < duration; offset += spacing) {
    const noteIndex = Math.floor(offset / spacing) % notes.length;
    const start = context.currentTime + offset;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = kind === 'rest' ? 'sine' : 'triangle';
    oscillator.frequency.value = notes[noteIndex];
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.5, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + noteLength);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(start);
    oscillator.stop(start + noteLength + 0.02);
  }

  window.setTimeout(() => void context.close(), (duration + 0.5) * 1000);
}

function notifyRest() {
  const originalTitle = document.title;
  let showingReminder = false;
  const titleInterval = window.setInterval(() => {
    showingReminder = !showingReminder;
    document.title = showingReminder ? '休息 5 分钟｜西游团队' : originalTitle;
  }, 800);
  window.setTimeout(() => {
    window.clearInterval(titleInterval);
    document.title = originalTitle;
  }, 15_000);

  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }
  const notification = new Notification('该休息了', {
    body: '已专注 25 分钟，请休息 5 分钟。点击返回工作看板。',
    icon: '/favicon.svg',
    tag: 'pomodoro-rest',
    requireInteraction: true,
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
  window.setTimeout(() => notification.close(), 15_000);
}

function reworkKey(task: TaskRow) {
  return `${task.id}:${task.rework_count}`;
}

function seenReworks(actor: Member) {
  try {
    const stored = JSON.parse(
      localStorage.getItem(`seen-reworks:${actor}`) || '[]',
    );
    return new Set<string>(Array.isArray(stored) ? stored : []);
  } catch {
    return new Set<string>();
  }
}

export function PomodoroTimer({
  actor,
  tasks,
}: {
  actor: Member;
  tasks: TaskRow[];
}) {
  const router = useRouter();
  const [now, setNow] = useState<Date | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [pendingRework, setPendingRework] = useState<string | null>(null);
  const previousPhase = useRef<string | null>(null);
  const state = now ? timerState(now) : null;

  const currentReworks = useMemo(
    () =>
      tasks
        .filter((task) => task.assignee === actor && task.status === '需修改')
        .map(reworkKey),
    [actor, tasks],
  );

  useEffect(() => {
    const initial = window.setTimeout(() => setNow(new Date()), 0);
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => router.refresh(), 30_000);
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [router]);

  useEffect(() => {
    if (!state) return;
    if (previousPhase.current && previousPhase.current !== state.phaseKey) {
      if (state.phase === 'rest') {
        notifyRest();
        if (soundEnabled) playReminder('rest');
      } else if (state.phase === 'work' && soundEnabled) {
        playReminder('work');
      }
    }
    previousPhase.current = state.phaseKey;
  }, [soundEnabled, state]);

  useEffect(() => {
    const update = window.setTimeout(() => {
      const seen = seenReworks(actor);
      const unseen = currentReworks.find((key) => !seen.has(key)) ?? null;
      setPendingRework(unseen);
      if (!unseen || !soundEnabled) return;
      playReminder('rework');
      seen.add(unseen);
      localStorage.setItem(`seen-reworks:${actor}`, JSON.stringify([...seen]));
      setPendingRework(null);
    }, 0);
    return () => window.clearTimeout(update);
  }, [actor, currentReworks, soundEnabled]);

  async function enableSound() {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    setSoundEnabled(true);
  }

  const phaseLabel =
    state?.phase === 'work'
      ? '专注中'
      : state?.phase === 'rest'
        ? '休息中'
        : '非工作时段';

  return (
    <section
      className={`pomodoro-panel phase-${state?.phase ?? 'off'}`}
      aria-label="番茄钟"
    >
      <div className="pomodoro-icon" aria-hidden="true">
        {state?.phase === 'rest' ? <Coffee /> : <TimerReset />}
      </div>
      <div className="pomodoro-copy">
        <span>番茄钟 · {actor}</span>
        <strong>{phaseLabel}</strong>
        <small>工作时段 09:30–12:00 · 14:00–18:30</small>
      </div>
      <div className="pomodoro-clock" aria-live="polite">
        <span>{state?.nextLabel ?? '正在校准时间'}</span>
        <strong>
          {state?.phase === 'off'
            ? '--:--'
            : formatCountdown(state?.remainingSeconds ?? 0)}
        </strong>
        <div className="pomodoro-progress" aria-hidden="true">
          <span style={{ width: `${(state?.progress ?? 0) * 100}%` }} />
        </div>
      </div>
      <div className="pomodoro-alerts">
        {pendingRework && (
          <span className="rework-alert">有返工待处理</span>
        )}
        <Button
          type="button"
          variant="outline"
          className="sound-toggle"
          onClick={enableSound}
          disabled={soundEnabled}
        >
          {soundEnabled ? <Bell /> : <BellOff />}
          {soundEnabled ? '提醒已开启' : '开启声音与通知'}
        </Button>
        <small>休息 / 开工 15 秒 · 返工音乐 30 秒</small>
      </div>
    </section>
  );
}
