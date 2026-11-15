export class Room {
  constructor() {
    this.clients = new Map();
    this.timer = { status: 'idle', duration: 300000, remaining: 300000, endsAt: null };
    this.revision = 0;
    this.closed = false;
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/init' && !this.keys) {
      this.keys = await request.json();
      this.expiry = setTimeout(() => this.end('ルームの有効期限が切れました。'), 2 * 60 * 60 * 1000);
      return new Response('ok');
    }
    if (!this.keys || this.closed) return new Response('ルームが終了しています。新しい招待を作成してください。', { status: 410 });
    // Includes unauthenticated and pending sockets to bound resources per room.
    if (this.clients.size >= 3) return new Response('ルームは満員です。', { status: 409 });
    const pair = new WebSocketPair();
    const [client, socket] = Object.values(pair);
    socket.accept();
    const info = { role: null, approved: false, lastSeen: Date.now(), count: 0, window: Date.now() };
    this.clients.set(socket, info);
    const authTimeout = setTimeout(() => { if (!info.role) this.remove(socket, '接続がタイムアウトしました。'); }, 10000);
    socket.addEventListener('message', event => {
      try { this.message(socket, event.data); } catch { this.send(socket, { type: 'error', message: '操作を処理できませんでした。' }); }
    });
    socket.addEventListener('close', () => { clearTimeout(authTimeout); this.remove(socket); });
    socket.addEventListener('error', () => this.remove(socket));
    if (!this.watchdog) this.watchdog = setInterval(() => {
      for (const [ws, data] of this.clients) if (Date.now() - data.lastSeen > 16000) this.remove(ws, '通信が切断されました。');
      this.broadcast({ type: 'clock', now: Date.now() });
    }, 5000);
    return new Response(null, { status: 101, webSocket: client });
  }
  send(socket, data) { try { socket.send(JSON.stringify(data)); } catch { /* close event handles cleanup */ } }
  broadcast(data) { for (const [ws, info] of this.clients) if (info.approved) this.send(ws, data); }
  snapshot() {
    this.broadcast({ type: 'state', revision: ++this.revision, timer: this.timer, connected: [...this.clients.values()].filter(x => x.approved).length === 2, now: Date.now() });
  }
  event(text) { this.broadcast({ type: 'event', text, at: Date.now(), id: crypto.randomUUID() }); }
  message(socket, raw) {
    const info = this.clients.get(socket);
    if (!info || typeof raw !== 'string' || raw.length > 5000) return this.remove(socket, '通信形式が正しくありません。');
    const now = Date.now();
    if (now - info.window > 1000) { info.window = now; info.count = 0; }
    if (++info.count > 20) return this.remove(socket, '操作が多すぎます。');
    let data;
    try { data = JSON.parse(raw); } catch { return this.remove(socket, '通信形式が正しくありません。'); }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hello' && !info.role) {
      const role = data.key === this.keys.hostKey ? 'host' : data.key === this.keys.inviteKey ? 'guest' : null;
      if (!role || [...this.clients.values()].some(x => x.role === role)) return this.remove(socket, '招待が無効、または既に参加済みです。');
      if (role === 'guest' && ![...this.clients.values()].some(x => x.role === 'host' && x.approved)) return this.remove(socket, '作成者が接続していません。');
      info.role = role;
      info.name = typeof data.name === 'string' ? data.name.trim().slice(0, 20) || (role === 'host' ? '作成者' : '参加者') : '参加者';
      info.approved = role === 'host';
      this.send(socket, { type: 'identity', role, name: info.name });
      if (role === 'guest') {
        this.send(socket, { type: 'pending' });
        this.broadcast({ type: 'join-request', name: info.name });
      }
      this.snapshot();
      return;
    }
    if (!info.role) return;
    info.lastSeen = now;
    if (data.type === 'ping') return this.send(socket, { type: 'clock', now });
    if (data.type === 'leave') return this.remove(socket, '退出しました。');
    if (!info.approved) return;
    if (data.type === 'approve' && info.role === 'host') {
      for (const [ws, pending] of this.clients) if (pending.role === 'guest' && !pending.approved) {
        pending.approved = true;
        this.send(ws, { type: 'approved' });
        this.event(`${pending.name}さんが参加しました。`);
      }
      return this.snapshot();
    }
    if (data.type === 'reject' && info.role === 'host') {
      for (const [ws, pending] of this.clients) if (pending.role === 'guest' && !pending.approved) this.remove(ws, '参加が見送られました。');
      return;
    }
    const paired = [...this.clients.values()].filter(x => x.approved).length === 2;
    if (data.type === 'chat' && paired && typeof data.text === 'string' && data.text.trim() && data.text.length <= 1000) {
      return this.broadcast({ type: 'chat', id: crypto.randomUUID(), role: info.role, name: info.name, text: data.text.trim(), at: now });
    }
    if (data.type === 'complete' && paired) return this.event(`${info.name}さんが「完了」を押しました。`);
    if (data.type !== 'timer') return;
    if (data.action === 'stop') { this.pause('stopped'); this.event(`${info.name}さんが停止しました。`); return this.snapshot(); }
    if (info.role !== 'host' || !paired) return;
    if (data.action === 'set' && Number.isInteger(data.seconds) && data.seconds >= 10 && data.seconds <= 3600 && this.timer.status !== 'running') {
      this.timer = { status: 'idle', duration: data.seconds * 1000, remaining: data.seconds * 1000, endsAt: null };
    } else if (data.action === 'start' && this.timer.status !== 'running') {
      const remaining = this.timer.remaining > 0 ? this.timer.remaining : this.timer.duration;
      this.timer = { ...this.timer, status: 'running', remaining, endsAt: now + remaining };
      clearTimeout(this.finish);
      this.finish = setTimeout(() => {
        this.timer = { ...this.timer, status: 'finished', remaining: 0, endsAt: null };
        this.event('タイマーが終了しました。'); this.snapshot();
      }, remaining);
    } else if (data.action === 'pause') this.pause('paused');
    else if (data.action === 'reset') { clearTimeout(this.finish); this.timer = { ...this.timer, status: 'idle', remaining: this.timer.duration, endsAt: null }; }
    else return;
    this.snapshot();
  }
  pause(status = 'paused') {
    clearTimeout(this.finish);
    this.timer = { ...this.timer, status, remaining: this.timer.endsAt ? Math.max(0, this.timer.endsAt - Date.now()) : this.timer.remaining, endsAt: null };
  }
  remove(socket, reason = '相手が退出しました。') {
    const info = this.clients.get(socket);
    if (!info) return;
    this.clients.delete(socket);
    this.send(socket, { type: 'ended', message: reason });
    try { socket.close(1000, 'closed'); } catch { /* already closed */ }
    if (info.role === 'host') return this.end('作成者が退出しました。新しい招待で接続してください。');
    if (info.approved) { this.pause('stopped'); this.event('参加者との接続が切れたため、停止しました。'); this.snapshot(); }
    if (info.role === 'guest') this.broadcast({ type: 'join-cleared' });
  }
  end(message) {
    this.closed = true;
    this.pause('stopped');
    clearInterval(this.watchdog); clearTimeout(this.expiry);
    for (const ws of this.clients.keys()) { this.send(ws, { type: 'ended', message }); try { ws.close(1000, 'closed'); } catch {} }
    this.clients.clear();
    this.keys = null;
  }
}
