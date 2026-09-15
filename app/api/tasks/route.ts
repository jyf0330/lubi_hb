import { z } from 'zod';
import { getD1, taskEvent } from '@/lib/task-data';
import { MEMBERS, TASK_TYPES, plannedPoints } from '@/lib/task-domain';
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

const createTaskSchema = z.object({
  actor: z.enum(MEMBERS),
  assignee: z.enum(MEMBERS).nullable(),
  title: z.string().trim().min(2, '任务标题至少 2 个字').max(120),
  type: z.enum(TASK_TYPES),
  priority: z.enum(['低', '普通', '高', '紧急']),
  estimatedMinutes: z.number().int().min(15).max(1440),
  deliverableExpectation: z.string().trim().max(500).optional(),
  acceptanceCriteria: z.string().trim().max(800).optional(),
  notes: z.string().trim().max(800).optional(),
  artProgressUrl: z.union([z.url(), z.literal('')]).optional(),
  artFinalUrl: z.union([z.url(), z.literal('')]).optional(),
  artSourceUrl: z.union([z.url(), z.literal('')]).optional(),
  testPlannedCases: z.number().int().nonnegative().optional(),
  testActualCases: z.number().int().nonnegative().optional(),
  testNewBugs: z.number().int().nonnegative().optional(),
  testValidBugs: z.number().int().nonnegative().optional(),
  testRegressionBugs: z.number().int().nonnegative().optional(),
  testSevereBugs: z.number().int().nonnegative().optional(),
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

export async function POST(request: Request) {
  try {
    const input = createTaskSchema.parse(await request.json());
    const db = getD1();
    const now = Date.now();
    const id = crypto.randomUUID();
    const status = input.assignee ? '今日待办' : '任务池';
    const plannedDate = input.assignee ? todayInShanghai() : null;
    const points = plannedPoints(input.estimatedMinutes);
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

    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO tasks (
            id, assignee, title, type, status, priority, planned_date,
            estimated_minutes, planned_points, deliverable_expectation,
            acceptance_criteria, notes, art_progress_url, art_final_url,
            art_source_url, test_planned_cases, test_actual_cases, test_new_bugs,
            test_valid_bugs, test_regression_bugs, test_severe_bugs, claimed_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.assignee,
            input.title,
            input.type,
            status,
            input.priority,
            plannedDate,
            input.estimatedMinutes,
            points,
            input.deliverableExpectation || null,
            input.acceptanceCriteria || null,
            input.notes || null,
            input.type === '美术' ? input.artProgressUrl || null : null,
            input.type === '美术' ? input.artFinalUrl || null : null,
            input.type === '美术' ? input.artSourceUrl || null : null,
            input.type === '测试' ? (input.testPlannedCases ?? null) : null,
            input.type === '测试' ? (input.testActualCases ?? null) : null,
            input.type === '测试' ? (input.testNewBugs ?? null) : null,
            input.type === '测试' ? (input.testValidBugs ?? null) : null,
            input.type === '测试' ? (input.testRegressionBugs ?? null) : null,
            input.type === '测试' ? (input.testSevereBugs ?? null) : null,
            input.assignee ? now : null,
            now,
            now,
          ),
        taskEvent(id, input.actor, '创建任务', null, status, null, now),
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
      ]);
    } catch (error) {
      await imageStore.cleanup();
      await fileStore.cleanup();
      throw error;
    }

    return Response.json(
      { ok: true, task: { id, status, plannedPoints: points } },
      { status: 201 },
    );
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message
        : error instanceof Error
          ? error.message
          : '创建任务失败。';
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
