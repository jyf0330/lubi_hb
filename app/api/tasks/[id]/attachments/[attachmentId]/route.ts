import { env } from 'cloudflare:workers';
import { getTaskAttachment } from '@/lib/task-data';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const { id, attachmentId } = await context.params;
  const attachment = await getTaskAttachment(id, attachmentId);
  if (!attachment) {
    return Response.json({ ok: false, error: '图片不存在。' }, { status: 404 });
  }
  if (!env.FILES) {
    return Response.json({ ok: false, error: '文件存储不可用。' }, { status: 503 });
  }
  const object = await env.FILES.get(attachment.storage_key);
  if (!object) {
    return Response.json({ ok: false, error: '图片文件不存在。' }, { status: 404 });
  }
  return new Response(object.body, {
    headers: {
      'Cache-Control': 'private, max-age=31536000',
      'Content-Length': String(attachment.size),
      'Content-Type': attachment.content_type,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
