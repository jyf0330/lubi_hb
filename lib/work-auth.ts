import { env } from 'cloudflare:workers';

export type WorkActor = { member: 'ZHC' | 'YWT'; role: 'employee' | 'manager' };

function safeEqual(left: string, right: string | undefined): boolean {
  if (!right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export function authenticateWorkRequest(request: Request): WorkActor | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (safeEqual(token, env.MCP_TOKEN_ZHC)) return { member: 'ZHC', role: 'employee' };
  if (safeEqual(token, env.MCP_TOKEN_YWT)) return { member: 'YWT', role: 'employee' };
  if (safeEqual(token, env.MCP_TOKEN_MANAGER)) return { member: 'ZHC', role: 'manager' };
  return null;
}

export function workAuthIsConfigured(): boolean {
  return Boolean(env.MCP_TOKEN_ZHC && env.MCP_TOKEN_YWT && env.MCP_TOKEN_MANAGER);
}
