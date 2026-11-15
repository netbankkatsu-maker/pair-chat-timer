import { createSession, isOwner } from './owner.js';
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function route(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (url.pathname === '/api/session' && request.method === 'GET') return json({ owner: await isOwner(request, env) });
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'このページから接続してください。' }, 403);
  if (url.pathname === '/api/owner' && request.method === 'POST') {
    if (!env.OWNER_KEY || request.headers.get('Authorization') !== `Bearer ${env.OWNER_KEY}`) return json({ error: '管理者認証に失敗しました。' }, 403);
    const token = await createSession(env.OWNER_KEY);
    return Response.json({ owner: true }, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': `pair_owner=${token}; Path=/api; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict` } });
  }
  if (url.pathname === '/api/rooms' && request.method === 'POST') {
    if (!await isOwner(request, env)) return json({ error: '部屋の作成は管理者だけが行えます。' }, 403);
    const id = crypto.randomUUID();
    const hostKey = crypto.randomUUID() + crypto.randomUUID();
    const inviteKey = crypto.randomUUID() + crypto.randomUUID();
    const room = env.ROOMS.get(env.ROOMS.idFromName(id));
    await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostKey, inviteKey }) }));
    return json({ id, hostKey, inviteKey });
  }
  const match = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/socket$/);
  if (match && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(new Request('https://room/socket', request));
  }
  return json({ error: '接続先が見つかりません。' }, 404);
}
