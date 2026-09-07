import { authenticateWorkRequest, workAuthIsConfigured } from '@/lib/work-auth';
import { handleWorkMcp } from '@/lib/work-mcp';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, OAI-Sites-Authorization, mcp-session-id, mcp-protocol-version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
};

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handle(request: Request) {
  if (!workAuthIsConfigured()) return withCors(Response.json({ error: 'Work MCP authentication is not configured.' }, { status: 503 }));
  const actor = authenticateWorkRequest(request);
  if (!actor) return withCors(Response.json({ error: 'Unauthorized' }, { status: 401 }));
  return withCors(await handleWorkMcp(request, actor));
}

export async function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
export async function DELETE(request: Request) { return handle(request); }
