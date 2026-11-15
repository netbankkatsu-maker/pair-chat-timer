import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const origin = process.env.TEST_ORIGIN || 'http://localhost:8787';
let ownerCookie;
async function authenticateOwner() {
  if (ownerCookie) return ownerCookie;
  const response = await fetch(`${origin}/api/owner`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${process.env.TEST_OWNER_KEY || 'local-test-owner-key'}` } });
  assert.equal(response.status, 200);
  ownerCookie = response.headers.get('set-cookie').split(';')[0];
  return ownerCookie;
}
async function room() {
  const response = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin, Cookie: await authenticateOwner() } });
  assert.equal(response.status, 200); return response.json();
}
async function connect(id, key, name = 'テスト') {
  const url = new URL(`/api/rooms/${id}/socket`, origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, { origin });
  const received = []; const waiters = [];
  ws.on('message', raw => {
    const data = JSON.parse(raw.toString()); received.push(data);
    for (const waiter of [...waiters]) if (waiter.check(data)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timeout); waiter.resolve(data); }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const client = { ws, received, send(data) { ws.send(JSON.stringify(data)); }, wait(check) {
    const existing = received.find(check); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { check, resolve, timeout: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Timed out waiting for event')); }, 4000) }; waiters.push(waiter);
    });
  }};
  client.send({ type: 'hello', key, name });
  return client;
}
const delay = () => new Promise(resolve => setTimeout(resolve, 150));
test('same-origin API rejects another website', async () => {
  const response = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: 'https://unrelated.example' } });
  assert.equal(response.status, 403);
});
test('two participants chat, synchronize timer, enforce roles, and stop on disconnect', { timeout: 15000 }, async t => {
  const r = await room(); const host = await connect(r.id, r.hostKey, '作成者');
  t.after(() => host.ws.close()); await host.wait(x => x.type === 'identity');
  const guest = await connect(r.id, r.inviteKey, '参加者'); t.after(() => guest.ws.close());
  await guest.wait(x => x.type === 'pending'); await host.wait(x => x.type === 'join-request');
  guest.send({ type: 'chat', text: '承認前' });
  await delay(); assert.ok(!host.received.some(x => x.type === 'chat'));
  host.send({ type: 'approve' }); await guest.wait(x => x.type === 'approved');
  await host.wait(x => x.type === 'state' && x.connected);
  guest.send({ type: 'chat', text: '<script>test</script> こんにちは' });
  const message = await host.wait(x => x.type === 'chat'); assert.equal(message.text, '<script>test</script> こんにちは');
  await guest.wait(x => x.type === 'chat');
  host.send({ type: 'timer', action: 'set', seconds: 60 });
  await guest.wait(x => x.type === 'state' && x.timer.duration === 60000);
  guest.send({ type: 'timer', action: 'start' }); await delay();
  assert.ok(!host.received.some(x => x.type === 'state' && x.timer.status === 'running'));
  host.send({ type: 'timer', action: 'start' });
  const running = await guest.wait(x => x.type === 'state' && x.timer.status === 'running'); assert.ok(running.timer.endsAt > running.now);
  guest.send({ type: 'complete' }); await host.wait(x => x.type === 'event' && x.text.includes('完了'));
  guest.send({ type: 'timer', action: 'stop' }); await host.wait(x => x.type === 'state' && x.timer.status === 'stopped');
  host.send({ type: 'timer', action: 'start' }); await delay();
  guest.ws.close();
  await host.wait(x => x.type === 'event' && x.text.includes('切れたため'));
  await host.wait(x => x.type === 'state' && !x.connected && x.timer.status === 'stopped');
});
test('invalid key, duplicate guest, and host departure are handled', { timeout: 15000 }, async t => {
  const r = await room(); const host = await connect(r.id, r.hostKey); t.after(() => host.ws.close());
  await host.wait(x => x.type === 'identity');
  const bad = await connect(r.id, 'invalid'); t.after(() => bad.ws.close());
  await bad.wait(x => x.type === 'ended');
  const guest = await connect(r.id, r.inviteKey); t.after(() => guest.ws.close());
  await guest.wait(x => x.type === 'pending');
  const extra = await connect(r.id, r.inviteKey); t.after(() => extra.ws.close());
  await extra.wait(x => x.type === 'ended');
  host.send({ type: 'approve' }); await guest.wait(x => x.type === 'approved');
  host.ws.close(); const ended = await guest.wait(x => x.type === 'ended'); assert.ok(ended.message.includes('作成者'));
});
test('pause/reset, rejected join, and automatic timer completion', { timeout: 20000 }, async t => {
  const r = await room(); const host = await connect(r.id, r.hostKey); t.after(() => host.ws.close());
  await host.wait(x => x.type === 'identity');
  const rejected = await connect(r.id, r.inviteKey); t.after(() => rejected.ws.close());
  await rejected.wait(x => x.type === 'pending'); host.send({ type: 'reject' });
  await rejected.wait(x => x.type === 'ended' && x.message.includes('見送られ'));
  const guest = await connect(r.id, r.inviteKey); t.after(() => guest.ws.close());
  await guest.wait(x => x.type === 'pending'); host.send({ type: 'approve' }); await guest.wait(x => x.type === 'approved');
  host.send({ type: 'timer', action: 'set', seconds: 10 });
  await guest.wait(x => x.type === 'state' && x.timer.duration === 10000);
  host.send({ type: 'timer', action: 'start' }); await guest.wait(x => x.type === 'state' && x.timer.status === 'running');
  host.send({ type: 'timer', action: 'pause' }); const paused = await guest.wait(x => x.type === 'state' && x.timer.status === 'paused');
  assert.equal(paused.timer.endsAt, null); assert.ok(paused.timer.remaining <= 10000);
  host.send({ type: 'timer', action: 'reset' });
  await guest.wait(x => x.type === 'state' && x.revision > paused.revision && x.timer.status === 'idle' && x.timer.remaining === 10000);
  const keepalive = setInterval(() => { host.send({ type: 'ping' }); guest.send({ type: 'ping' }); }, 3000); t.after(() => clearInterval(keepalive));
  host.send({ type: 'timer', action: 'start' });
  // Completion takes ten seconds; use a dedicated wait rather than the short event helper.
  const finished = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timer did not finish')), 13000);
    const listener = raw => { const d = JSON.parse(raw.toString()); if (d.type === 'state' && d.timer.status === 'finished') { clearTimeout(timeout); guest.ws.off('message', listener); resolve(d); } };
    guest.ws.on('message', listener);
  });
  assert.equal(finished.timer.remaining, 0); assert.equal(finished.timer.endsAt, null);
});

test('only the owner can create rooms, including direct API requests', async () => {
  const unauthorized = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin } });
  assert.equal(unauthorized.status, 403);
  const forged = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin, Cookie: `pair_owner=${Date.now()+100000}.`+'0'.repeat(64) } });
  assert.equal(forged.status, 403);
  const rejected = await fetch(`${origin}/api/owner`, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer wrong' } });
  assert.equal(rejected.status, 403);
  const session = await fetch(`${origin}/api/session`); assert.deepEqual(await session.json(), { owner: false });
  const owner = await fetch(`${origin}/api/session`, { headers: { Cookie: await authenticateOwner() } }); assert.deepEqual(await owner.json(), { owner: true });
});
test('accepted invitations cannot be reused; only host can issue a new one', { timeout: 15000 }, async t => {
  const r = await room(); const host = await connect(r.id, r.hostKey); t.after(() => host.ws.close());
  await host.wait(x => x.type === 'identity');
  const guest = await connect(r.id, r.inviteKey); t.after(() => guest.ws.close());
  await guest.wait(x => x.type === 'pending'); host.send({ type: 'approve' }); await guest.wait(x => x.type === 'approved');
  guest.send({ type: 'new-invite' }); await delay(); assert.ok(!guest.received.some(x => x.type === 'invite'));
  guest.ws.close(); await host.wait(x => x.type === 'event' && x.text.includes('切れたため'));
  const retry = await connect(r.id, r.inviteKey); t.after(() => retry.ws.close()); await retry.wait(x => x.type === 'ended');
  host.send({ type: 'new-invite' }); const fresh = await host.wait(x => x.type === 'invite'); assert.notEqual(fresh.key, r.inviteKey);
  const next = await connect(r.id, fresh.key); t.after(() => next.ws.close()); await next.wait(x => x.type === 'pending');
  host.send({ type: 'approve' }); await next.wait(x => x.type === 'approved');
});
