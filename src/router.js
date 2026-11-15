const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function route(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'このページから接続してください。' }, 403);
  if (url.pathname === '/api/rooms' && request.method === 'POST') {
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
