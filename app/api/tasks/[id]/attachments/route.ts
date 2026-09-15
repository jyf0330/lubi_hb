import { getTaskAttachments, getTaskById } from '@/lib/task-data';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const task = await getTaskById(id);
  if (!task) return Response.json({ ok: false, error: '任务不存在。' }, { status: 404 });

  const attachments = await getTaskAttachments(id);
  return Response.json({
    ok: true,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.content_type,
      size: attachment.size,
      createdAt: attachment.created_at,
      url: `/api/tasks/${id}/attachments/${attachment.id}`,
    })),
  });
}
