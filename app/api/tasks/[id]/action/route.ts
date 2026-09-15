import { z } from 'zod';
import { getD1, getTaskById, taskEvent } from '@/lib/task-data';
import {
  MEMBERS,
  TASK_ACTIONS,
  assertTransition,
  type TaskStatus,
} from '@/lib/task-domain';
import {
  MAX_FILE_DATA_LENGTH,
  MAX_IMAGE_DATA_LENGTH,
  storeTaskFiles,
  storeTaskImages,
  type EncodedFilePayload,
  type EncodedImagePayload,
} from '@/lib/task-attachments';

const imageSchema = z.object({
  name: z.string().max(120),
  data: z.string().min(1).max(MAX_IMAGE_DATA_LENGTH),
  contentType: z.string().optional(),
});

const fileSchema = z.object({
  name: z.string().max(160),
  data: z.string().min(1).max(MAX_FILE_DATA_LENGTH),
  contentType: z.string().max(120).optional(),
});

const actionSchema = z.object({
  action: z.enum(TASK_ACTIONS),
  actor: z.enum(MEMBERS),
  detail: z.string().trim().max(1200).optional(),
  deliverableUrl: z.union([z.url(), z.literal('')]).optional(),
  images: z.array(imageSchema).max(6).optional(),
  files: z.array(fileSchema).max(6).optional(),
});

function todayInShanghai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function actualMinutes(taskId: string, now: number) {
  const row = await getD1()
    .prepare(
      `SELECT COALESCE(SUM((COALESCE(ended_at, ?) - started_at) / 60000.0), 0) AS minutes
       FROM work_sessions WHERE task_id = ?`,
    )
    .bind(now, taskId)
    .first<{ minutes: number }>();
  return Math.round(Number(row?.minutes ?? 0));
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const input = actionSchema.parse(await request.json());
    const task = await getTaskById(id);
    if (!task)
      return Response.json(
        { ok: false, error: '任务不存在。' },
        { status: 404 },
      );

    assertTransition(
      {
        assignee: task.assignee,
        status: task.status,
        isPaused: Boolean(task.is_paused),
      },
      input.action,
      input.actor,
    );

    if (['submit', 'rework', 'block'].includes(input.action) && !input.detail) {
      throw new Error('请填写本次操作的说明。');
    }

    const db = getD1();
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    let nextStatus: TaskStatus = task.status;
    let eventType = '';
    let message = '';
    const openSession = await db
      .prepare(
        'SELECT id FROM work_sessions WHERE task_id = ? AND ended_at IS NULL LIMIT 1',
      )
      .bind(id)
      .first<{ id: string }>();

    if (input.action === 'claim') {
      nextStatus = '今日待办';
      eventType = '领取任务';
      message = `已由 ${input.actor} 领取任务。`;
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET assignee = ?, status = '今日待办', planned_date = ?,
             claimed_at = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(input.actor, todayInShanghai(), now, now, id),
      );
    } else if (input.action === 'start' || input.action === 'resume') {
      const active = await db
        .prepare(
          `SELECT title FROM tasks
           WHERE assignee = ? AND status = '进行中' AND is_paused = 0 AND id != ?
           LIMIT 1`,
        )
        .bind(input.actor, id)
        .first<{ title: string }>();
      if (active) throw new Error(`请先暂停正在进行的任务“${active.title}”。`);
      nextStatus = '进行中';
      eventType = input.action === 'start' ? '开始任务' : '继续任务';
      message = input.action === 'start' ? '任务已开始。' : '任务已继续。';
      statements.push(
        db
          .prepare(
            "UPDATE tasks SET status = '进行中', is_paused = 0, updated_at = ? WHERE id = ?",
          )
          .bind(now, id),
        db
          .prepare(
            'INSERT INTO work_sessions (id, task_id, assignee, started_at) VALUES (?, ?, ?, ?)',
          )
          .bind(crypto.randomUUID(), id, input.actor, now),
      );
    } else if (input.action === 'pause') {
      eventType = '暂停任务';
      message = '任务已暂停。';
      if (!openSession) throw new Error('找不到正在计时的工作记录。');
      statements.push(
        db
          .prepare(
            "UPDATE work_sessions SET ended_at = ?, end_reason = '暂停' WHERE id = ?",
          )
          .bind(now, openSession.id),
        db
          .prepare(
            'UPDATE tasks SET is_paused = 1, updated_at = ? WHERE id = ?',
          )
          .bind(now, id),
      );
    } else if (input.action === 'submit') {
      nextStatus = '待验收';
      eventType = '提交验收';
      message = '任务已提交待验收。';
      if (openSession) {
        statements.push(
          db
            .prepare(
              "UPDATE work_sessions SET ended_at = ?, end_reason = '提交' WHERE id = ?",
            )
            .bind(now, openSession.id),
        );
      }
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET status = '待验收', is_paused = 0, result_summary = ?,
             submitted_at = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(input.detail, now, now, id),
      );
      if (input.deliverableUrl) {
        statements.push(
          db
            .prepare(
              `INSERT INTO deliverables (id, task_id, kind, label, url, created_at)
               VALUES (?, ?, '链接', '交付物', ?, ?)`,
            )
            .bind(crypto.randomUUID(), id, input.deliverableUrl, now),
        );
      }
    } else if (input.action === 'accept') {
      nextStatus = '已完成';
      eventType = '验收通过';
      message = '任务已验收通过。';
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET status = '已完成', acceptance_result = ?, completed_at = ?,
             updated_at = ? WHERE id = ?`,
          )
          .bind(input.detail || '验收通过', now, now, id),
      );
    } else if (input.action === 'rework') {
      nextStatus = '需修改';
      eventType = '退回修改';
      message = '任务已退回修改。';
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET status = '需修改', acceptance_result = ?,
             rework_count = rework_count + 1, updated_at = ? WHERE id = ?`,
          )
          .bind(input.detail, now, id),
      );
    } else if (input.action === 'block') {
      nextStatus = '阻塞';
      eventType = '标记阻塞';
      message = '任务已标记阻塞。';
      if (openSession) {
        statements.push(
          db
            .prepare(
              "UPDATE work_sessions SET ended_at = ?, end_reason = '阻塞' WHERE id = ?",
            )
            .bind(now, openSession.id),
        );
      }
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET status = '阻塞', is_paused = 0, blocked_reason = ?,
             updated_at = ? WHERE id = ?`,
          )
          .bind(input.detail, now, id),
      );
    } else {
      nextStatus = '今日待办';
      eventType = '解除阻塞';
      message = '任务已解除阻塞并回到今日待办。';
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET status = '今日待办', blocked_reason = NULL,
             updated_at = ? WHERE id = ?`,
          )
          .bind(now, id),
      );
    }

    statements.push(
      taskEvent(
        id,
        input.actor,
        eventType,
        task.status,
        nextStatus,
        input.detail || null,
        now,
      ),
    );
    const imageStore = await storeTaskImages(
      id,
      (input.images ?? []) as EncodedImagePayload[],
      now,
    );
    let fileStore;
    try {
      fileStore = await storeTaskFiles(
        id,
        (input.files ?? []) as EncodedFilePayload[],
        now,
      );
    } catch (error) {
      await imageStore.cleanup();
      throw error;
    }
    statements.push(
      ...imageStore.records.map((image) =>
        db
          .prepare(
            `INSERT INTO task_attachments
             (id, task_id, name, content_type, size, storage_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            image.id,
            image.taskId,
            image.name,
            image.contentType,
            image.size,
            image.storageKey,
            image.createdAt,
          ),
      ),
      ...fileStore.records.map((file) =>
        db
          .prepare(
            `INSERT INTO task_attachments
             (id, task_id, name, content_type, size, storage_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            file.id,
            file.taskId,
            file.name,
            file.contentType,
            file.size,
            file.storageKey,
            file.createdAt,
          ),
      ),
    );
    try {
      await db.batch(statements);
    } catch (error) {
      await imageStore.cleanup();
      await fileStore.cleanup();
      throw error;
    }

    return Response.json({
      ok: true,
      message,
      task: {
        id,
        status: nextStatus,
        actualMinutes: await actualMinutes(id, now),
      },
    });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message
        : error instanceof Error
          ? error.message
          : '任务操作失败。';
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
