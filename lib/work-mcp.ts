import { env } from 'cloudflare:workers';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { WorkActor } from './work-auth';
import { TASK_TYPES, plannedPoints } from './task-domain';

const writable = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;
const readonly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function result(message: string, data: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { ok: true, ...data },
  };
}

function todayInShanghai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function getTask(taskId: string, member: string) {
  return env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND assignee = ?')
    .bind(taskId, member)
    .first<Record<string, unknown>>();
}

async function getActive(member: string) {
  return env.DB.prepare(`
    SELECT t.*, ws.id AS session_id, ws.started_at AS session_started_at
    FROM tasks t JOIN work_sessions ws ON ws.task_id = t.id
    WHERE t.assignee = ? AND t.status = '进行中' AND t.is_paused = 0 AND ws.ended_at IS NULL
    ORDER BY ws.started_at DESC LIMIT 1
  `)
    .bind(member)
    .first<Record<string, unknown>>();
}

async function actualMinutes(taskId: string, now: number) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(SUM((COALESCE(ended_at, ?) - started_at) / 60000.0), 0) AS minutes
    FROM work_sessions WHERE task_id = ?
  `)
    .bind(now, taskId)
    .first<{ minutes: number }>();
  return Math.round(Number(row?.minutes ?? 0));
}

function eventStatement(
  taskId: string,
  actor: string,
  eventType: string,
  fromStatus: string | null,
  toStatus: string | null,
  detail: string | null,
  now: number,
) {
  return env.DB.prepare(
    'INSERT INTO task_events (id, task_id, actor, event_type, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    crypto.randomUUID(),
    taskId,
    actor,
    eventType,
    fromStatus,
    toStatus,
    detail,
    now,
  );
}

function createServer(actor: WorkActor) {
  const server = new McpServer(
    { name: 'game-team-work', version: '1.0.0' },
    {
      instructions:
        'Only write after the employee confirms. Call work_get_active before starting, pausing, resuming, blocking, or finishing. Server timestamps are authoritative. One employee may have only one actively timed task. Never report success unless the tool returns ok=true.',
    },
  );

  server.registerTool(
    'work_get_active',
    {
      title: '查看当前任务',
      description:
        '查看当前员工正在计时或暂停中的任务。执行开始、暂停、继续、阻塞或完成前先调用。',
      inputSchema: {},
      annotations: readonly,
    },
    async () => {
      const active = await env.DB.prepare(`
      SELECT t.*, ws.started_at AS session_started_at
      FROM tasks t LEFT JOIN work_sessions ws ON ws.task_id = t.id AND ws.ended_at IS NULL
      WHERE t.assignee = ? AND t.status = '进行中'
      ORDER BY t.updated_at DESC LIMIT 1
    `)
        .bind(actor.member)
        .first<Record<string, unknown>>();
      if (!active) return result('当前没有进行中的任务。', { task: null });
      return result(
        `当前任务：${String(active.title)}${active.is_paused ? '（已暂停）' : '（计时中）'}`,
        { task: active },
      );
    },
  );

  server.registerTool(
    'work_create_tasks',
    {
      title: '登记工作任务',
      description:
        '员工确认 AI 的任务拆分后，将选中的一项或多项工作登记到今日待办。不会自动开始计时。',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).max(120),
              type: z.enum(TASK_TYPES),
              estimated_minutes: z.number().int().min(15).max(1440),
              deliverable_expectation: z.string().max(300).optional(),
              acceptance_criteria: z.string().max(500).optional(),
              art_progress_url: z.url().optional(),
              art_final_url: z.url().optional(),
              art_source_url: z.url().optional(),
              test_planned_cases: z.number().int().nonnegative().optional(),
              test_actual_cases: z.number().int().nonnegative().optional(),
              test_new_bugs: z.number().int().nonnegative().optional(),
              test_valid_bugs: z.number().int().nonnegative().optional(),
              test_regression_bugs: z.number().int().nonnegative().optional(),
              test_severe_bugs: z.number().int().nonnegative().optional(),
              deadline_at: z.iso.datetime().optional(),
              dependency_titles: z.array(z.string().max(120)).max(8).optional(),
              parallel_group: z.string().max(40).optional(),
            }),
          )
          .min(1)
          .max(8),
      },
      annotations: writable,
    },
    async ({ tasks }) => {
      const now = Date.now();
      const created = tasks.map((task) => ({
        ...task,
        id: crypto.randomUUID(),
        planned_points: plannedPoints(task.estimated_minutes),
      }));
      const statements = created.flatMap((task) => [
        env.DB.prepare(
          `INSERT INTO tasks (id, assignee, title, type, status, priority, planned_date, deadline_at, estimated_minutes, planned_points, deliverable_expectation, acceptance_criteria, notes, art_progress_url, art_final_url, art_source_url, test_planned_cases, test_actual_cases, test_new_bugs, test_valid_bugs, test_regression_bugs, test_severe_bugs, claimed_at, created_at, updated_at) VALUES (?, ?, ?, ?, '今日待办', '普通', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          task.id,
          actor.member,
          task.title,
          task.type,
          todayInShanghai(),
          task.deadline_at ? Date.parse(task.deadline_at) : null,
          task.estimated_minutes,
          task.planned_points,
          task.deliverable_expectation ?? null,
          task.acceptance_criteria ?? null,
          JSON.stringify({
            dependency_titles: task.dependency_titles ?? [],
            parallel_group: task.parallel_group ?? null,
          }),
          task.type === '美术' ? (task.art_progress_url ?? null) : null,
          task.type === '美术' ? (task.art_final_url ?? null) : null,
          task.type === '美术' ? (task.art_source_url ?? null) : null,
          task.type === '测试' ? (task.test_planned_cases ?? null) : null,
          task.type === '测试' ? (task.test_actual_cases ?? null) : null,
          task.type === '测试' ? (task.test_new_bugs ?? null) : null,
          task.type === '测试' ? (task.test_valid_bugs ?? null) : null,
          task.type === '测试' ? (task.test_regression_bugs ?? null) : null,
          task.type === '测试' ? (task.test_severe_bugs ?? null) : null,
          now,
          now,
          now,
        ),
        eventStatement(
          task.id,
          actor.member,
          '创建任务',
          null,
          '今日待办',
          null,
          now,
        ),
      ]);
      await env.DB.batch(statements);
      return result(`已登记 ${created.length} 项任务，尚未开始计时。`, {
        tasks: created.map(({ id, title, planned_points }) => ({
          id,
          title,
          planned_points,
          status: '今日待办',
        })),
      });
    },
  );

  server.registerTool(
    'work_start_task',
    {
      title: '开始任务',
      description: '员工确认开始后，为指定任务打开服务器计时并进入进行中。',
      inputSchema: { task_id: z.uuid() },
      annotations: writable,
    },
    async ({ task_id }) => {
      const active = await getActive(actor.member);
      if (active)
        throw new Error(
          `已有正在计时的任务：${String(active.title)}。请先暂停或完成它。`,
        );
      const task = await getTask(task_id, actor.member);
      if (!task) throw new Error('找不到该员工的任务。');
      if (!['今日待办', '需修改'].includes(String(task.status)))
        throw new Error(`任务状态 ${String(task.status)} 不能开始。`);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE tasks SET status = '进行中', is_paused = 0, updated_at = ? WHERE id = ?",
        ).bind(now, task_id),
        env.DB.prepare(
          'INSERT INTO work_sessions (id, task_id, assignee, started_at) VALUES (?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), task_id, actor.member, now),
        eventStatement(
          task_id,
          actor.member,
          '开始计时',
          String(task.status),
          '进行中',
          null,
          now,
        ),
      ]);
      return result(`已开始：${String(task.title)}`, {
        task_id,
        status: '进行中',
        started_at: new Date(now).toISOString(),
      });
    },
  );

  server.registerTool(
    'work_pause_task',
    {
      title: '暂停任务',
      description: '员工确认暂停后关闭当前计时段，任务仍保留在进行中。',
      inputSchema: { reason: z.string().max(300).optional() },
      annotations: writable,
    },
    async ({ reason }) => {
      const active = await getActive(actor.member);
      if (!active) throw new Error('当前没有正在计时的任务。');
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE work_sessions SET ended_at = ?, end_reason = '暂停' WHERE id = ?",
        ).bind(now, active.session_id),
        env.DB.prepare(
          'UPDATE tasks SET is_paused = 1, updated_at = ? WHERE id = ?',
        ).bind(now, active.id),
        eventStatement(
          String(active.id),
          actor.member,
          '暂停计时',
          '进行中',
          '进行中',
          reason ?? null,
          now,
        ),
      ]);
      return result(`已暂停：${String(active.title)}`, {
        task_id: active.id,
        status: '进行中',
        paused: true,
      });
    },
  );

  server.registerTool(
    'work_resume_task',
    {
      title: '继续任务',
      description: '员工确认继续后，为已暂停任务打开新的服务器计时段。',
      inputSchema: { task_id: z.uuid() },
      annotations: writable,
    },
    async ({ task_id }) => {
      if (await getActive(actor.member))
        throw new Error('已有另一项任务正在计时。');
      const task = await getTask(task_id, actor.member);
      if (!task || task.status !== '进行中' || !task.is_paused)
        throw new Error('该任务不是可继续的暂停任务。');
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          'UPDATE tasks SET is_paused = 0, updated_at = ? WHERE id = ?',
        ).bind(now, task_id),
        env.DB.prepare(
          'INSERT INTO work_sessions (id, task_id, assignee, started_at) VALUES (?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), task_id, actor.member, now),
        eventStatement(
          task_id,
          actor.member,
          '继续计时',
          '进行中',
          '进行中',
          null,
          now,
        ),
      ]);
      return result(`已继续：${String(task.title)}`, {
        task_id,
        status: '进行中',
        resumed_at: new Date(now).toISOString(),
      });
    },
  );

  server.registerTool(
    'work_block_task',
    {
      title: '标记阻塞',
      description:
        '工作因需求、程序、素材、权限等原因无法继续时，员工确认后记录阻塞原因。',
      inputSchema: { task_id: z.uuid(), reason: z.string().min(2).max(500) },
      annotations: writable,
    },
    async ({ task_id, reason }) => {
      const task = await getTask(task_id, actor.member);
      if (!task) throw new Error('找不到该员工的任务。');
      const now = Date.now();
      const open = await env.DB.prepare(
        'SELECT id FROM work_sessions WHERE task_id = ? AND ended_at IS NULL LIMIT 1',
      )
        .bind(task_id)
        .first<{ id: string }>();
      const statements = [
        env.DB.prepare(
          "UPDATE tasks SET status = '阻塞', is_paused = 0, blocked_reason = ?, updated_at = ? WHERE id = ?",
        ).bind(reason, now, task_id),
        eventStatement(
          task_id,
          actor.member,
          '任务阻塞',
          String(task.status),
          '阻塞',
          reason,
          now,
        ),
      ];
      if (open)
        statements.unshift(
          env.DB.prepare(
            "UPDATE work_sessions SET ended_at = ?, end_reason = '阻塞' WHERE id = ?",
          ).bind(now, open.id),
        );
      await env.DB.batch(statements);
      return result(`已标记阻塞：${String(task.title)}`, {
        task_id,
        status: '阻塞',
        reason,
      });
    },
  );

  server.registerTool(
    'work_finish_task',
    {
      title: '完成并提交验收',
      description:
        '员工确认 AI 生成的完成总结后，结束计时、保存交付物并提交到待验收。',
      inputSchema: {
        task_id: z.uuid(),
        summary: z.string().min(2).max(1200),
        deliverable_urls: z.array(z.url()).max(12).optional(),
      },
      annotations: writable,
    },
    async ({ task_id, summary, deliverable_urls = [] }) => {
      const task = await getTask(task_id, actor.member);
      if (!task || task.status !== '进行中')
        throw new Error('该任务不在进行中。');
      const now = Date.now();
      const open = await env.DB.prepare(
        'SELECT id FROM work_sessions WHERE task_id = ? AND ended_at IS NULL LIMIT 1',
      )
        .bind(task_id)
        .first<{ id: string }>();
      const statements = [
        env.DB.prepare(
          "UPDATE tasks SET status = '待验收', is_paused = 0, result_summary = ?, submitted_at = ?, updated_at = ? WHERE id = ?",
        ).bind(summary, now, now, task_id),
        eventStatement(
          task_id,
          actor.member,
          '提交验收',
          '进行中',
          '待验收',
          summary,
          now,
        ),
        ...deliverable_urls.map((url, index) =>
          env.DB.prepare(
            'INSERT INTO deliverables (id, task_id, kind, label, url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).bind(
            crypto.randomUUID(),
            task_id,
            '链接',
            `交付物 ${index + 1}`,
            url,
            now,
          ),
        ),
      ];
      if (open)
        statements.unshift(
          env.DB.prepare(
            "UPDATE work_sessions SET ended_at = ?, end_reason = '提交' WHERE id = ?",
          ).bind(now, open.id),
        );
      await env.DB.batch(statements);
      const minutes = await actualMinutes(task_id, now);
      return result(
        `已提交待验收：${String(task.title)}，实际记录 ${minutes} 分钟。`,
        {
          task_id,
          status: '待验收',
          actual_minutes: minutes,
          summary,
          deliverables: deliverable_urls,
        },
      );
    },
  );

  return server;
}

export async function handleWorkMcp(
  request: Request,
  actor: WorkActor,
): Promise<Response> {
  const server = createServer(actor);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
