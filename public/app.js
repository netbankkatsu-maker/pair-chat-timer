const $ = id => document.getElementById(id);
const hash = new URLSearchParams(location.hash.slice(1));
let inviteId = hash.get('room');
let inviteKey = hash.get('key');
// Keep invitation secrets out of the address bar and referrers once read.
if (location.hash) history.replaceState(null, '', location.pathname);
let owner = false, roomId = null, inviteAvailable = true;
const ownerActivation = hash.get('owner');
let socket, role, approved = false, paired = false, connecting = false, stopped = false;
let timer = { status: 'idle', duration: 300000, remaining: 300000, endsAt: null };
let revision = 0, offset = 0, heartbeat, lastReceived = 0, toastTimeout;
window.addEventListener('hashchange', () => { if (location.hash) location.reload(); });
const events = new Set();
if (inviteId && inviteKey) {
  $('room-title').textContent = 'ふたりの部屋に参加';
  $('room-description').textContent = '表示名を入れて、参加リクエストを送りましょう。';
  $('connect-button').textContent = '参加リクエストを送る ↗';
}
function status(text, error = false) { $('status-message').textContent = text; $('status-message').classList.toggle('error', error); }
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimeout); toastTimeout = setTimeout(() => $('toast').hidden = true, 3000); }
function send(data) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }
function updateControls() {
  const transportOpen = socket?.readyState === WebSocket.OPEN && !stopped;
  const pending = transportOpen && role === 'guest' && !approved;
  const online = transportOpen && approved;
  const host = role === 'host' && online && paired;
  $('duration').disabled = !host || timer.status === 'running';
  $('start').disabled = !host || timer.status === 'running';
  $('start').textContent = timer.status === 'paused' || timer.status === 'stopped' ? '再開' : '開始';
  $('pause').disabled = !host || timer.status !== 'running';
  $('reset').disabled = !host;
  $('stop').disabled = !online;
  $('complete').disabled = !online || !paired;
  $('message').disabled = !online || !paired;
  $('send').disabled = !online || !paired;
  $('invitation').hidden = !(role === 'host' && online && inviteAvailable);
  $('new-invite').hidden = !(role === 'host' && online && !paired && !inviteAvailable);
  $('people').textContent = paired ? '2 / 2' : online ? '1 / 2' : '0 / 2';
  $('connection').textContent = stopped ? '切断' : paired ? '接続済み' : pending ? '承認待ち' : online ? '相手を待機中' : connecting ? '接続中' : '未接続';
  $('connection').className = `live ${paired ? 'online' : online || pending || connecting ? 'pending' : ''}`;
  $('timer-note').textContent = !paired ? 'ふたりが揃ったら、スタート' : role === 'host' ? 'あなたがタイマーを操作できます' : '作成者がタイマーを操作します';
}
function renderTime() {
  const remaining = timer.status === 'running' && timer.endsAt ? Math.max(0, timer.endsAt - (Date.now() + offset)) : timer.remaining;
  const seconds = Math.ceil(remaining / 1000);
  $('time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('timer-state').textContent = { idle: 'READY WHEN YOU ARE', running: 'TIME TOGETHER', paused: 'TAKE YOUR TIME', stopped: 'STOPPED', finished: 'TIME IS UP' }[timer.status];
}
function addEvent(data) {
  if (data.id && events.has(data.id)) return;
  if (data.id) events.add(data.id);
  $('empty').hidden = true;
  const element = document.createElement('div');
  if (data.type === 'chat') {
    element.className = `bubble-row ${data.role === role ? 'self' : ''}`;
    const meta = document.createElement('div'); meta.className = 'bubble-meta';
    meta.textContent = `${data.name} · ${new Date(data.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = data.text;
    element.append(meta, bubble);
  } else { element.className = 'system-event'; element.textContent = data.text; }
  $('messages').append(element);
  while ($('messages').children.length > 201) { const child = [...$('messages').children].find(x => x.id !== 'empty'); child?.remove(); }
  if (events.size > 500) events.delete(events.values().next().value);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function disconnect(message = '接続が切れました。新しい部屋を作成してください。') {
  if (stopped) return;
  stopped = true; connecting = false; approved = false; paired = false;
  clearInterval(heartbeat);
  if (timer.endsAt) timer.remaining = Math.max(0, timer.endsAt - Date.now() - offset);
  timer.status = 'stopped'; timer.endsAt = null;
  status(message, true); $('join-request').hidden = true; $('invitation').hidden = true;
  $('leave').hidden = true; $('connect-button').disabled = !inviteId && !owner;
  $('connect-button').textContent = inviteId ? '参加を再試行' : '新しい部屋をつくる ↗';
  $('join-form').hidden = false;
  socket?.close(); updateControls(); renderTime();
}
$('join-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (connecting || (!inviteId && !owner)) return;
  connecting = true; stopped = false; approved = false; paired = false; revision = 0; events.clear();
  for (const child of [...$('messages').children]) if (child.id !== 'empty') child.remove();
  $('empty').hidden = false;
  $('connect-button').disabled = true; status('接続しています…'); updateControls();
  let id = inviteId, key = inviteKey;
  try {
    if (!id) {
      const response = await fetch('/api/rooms', { method: 'POST' });
      if (!response.ok) throw new Error(response.status === 403 ? '部屋の作成は管理者だけが行えます。' : '部屋を作成できませんでした。少し待って再試行してください。');
      const result = await response.json(); id = result.id; key = result.hostKey;
      $('invite-url').value = `${location.origin}${location.pathname}#room=${id}&key=${result.inviteKey}`;
    }
    roomId = id;
    const endpoint = new URL(`/api/rooms/${id}/socket`, location.origin); endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(endpoint);
    const activeSocket = socket;
    const connectTimeout = setTimeout(() => { if (socket === activeSocket && connecting) disconnect('接続がタイムアウトしました。再試行してください。'); }, 15000);
    socket.addEventListener('open', () => {
      clearTimeout(connectTimeout); lastReceived = Date.now();
      send({ type: 'hello', key, name: $('name').value.trim() });
      heartbeat = setInterval(() => {
        if (!document.hidden && Date.now() - lastReceived > 30000) return disconnect('通信を確認できないため停止しました。再接続してください。');
        send({ type: 'ping' });
      }, 4000);
    });
    socket.addEventListener('message', event => {
      if (socket !== activeSocket || stopped) return;
      lastReceived = Date.now();
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (data.now) offset = data.now - Date.now();
      switch (data.type) {
        case 'identity':
          role = data.role; approved = role === 'host'; connecting = false;
          $('join-form').hidden = true; $('leave').hidden = false;
          $('role-label').textContent = role === 'host' ? 'あなたが操作' : '相手が操作';
          $('room-title').textContent = 'ふたりの部屋';
          $('room-description').textContent = role === 'host' ? '相手を招待して、時間を共有しましょう。' : '招待された部屋に接続しています。';
          $('invitation').hidden = role !== 'host';
          status(role === 'host' ? '招待リンクを相手に送ってください。' : '作成者の承認を待っています。');
          break;
        case 'pending': status('作成者の承認を待っています。'); break;
        case 'approved': approved = true; status('接続しました。ふたりの時間をどうぞ。'); break;
        case 'join-request': $('request-name').textContent = `${data.name}さんが参加を希望しています。`; $('join-request').hidden = false; break;
        case 'join-cleared': $('join-request').hidden = true; break;
        case 'state':
          if (data.revision <= revision) break;
          revision = data.revision; timer = data.timer; paired = data.connected; inviteAvailable = data.inviteAvailable;
          if (paired) { status('接続しました。ふたりの時間をどうぞ。'); $('join-request').hidden = true; }
          if (role === 'host') $('duration').value = String(timer.duration / 1000);
          break;
        case 'invite':
          $('invite-url').value = `${location.origin}${location.pathname}#room=${roomId}&key=${data.key}`;
          inviteAvailable = true; toast('新しい招待リンクを発行しました'); break;
        case 'chat': case 'event': addEvent(data); break;
        case 'error': toast(data.message); break;
        case 'ended': disconnect(data.message); break;
      }
      updateControls(); renderTime();
    });
    socket.addEventListener('close', () => { clearTimeout(connectTimeout); if (socket === activeSocket) disconnect(); });
    socket.addEventListener('error', () => { if (socket === activeSocket) disconnect('接続できませんでした。招待リンクと通信環境を確認してください。'); });
  } catch (error) { disconnect(error.message); }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('invite-url').value); toast('招待リンクをコピーしました'); }
  catch { $('invite-url').select(); toast('招待リンクを選択しました。コピーしてください。'); }
});
$('new-invite').addEventListener('click', () => send({ type: 'new-invite' }));
$('approve').addEventListener('click', () => { send({ type: 'approve' }); $('join-request').hidden = true; });
$('reject').addEventListener('click', () => { send({ type: 'reject' }); $('join-request').hidden = true; });
$('leave').addEventListener('click', () => { send({ type: 'leave' }); disconnect('退出しました。会話の記録を消去しました。'); for (const child of [...$('messages').children]) if (child.id !== 'empty') child.remove(); $('empty').hidden = false; });
$('duration').addEventListener('change', () => send({ type: 'timer', action: 'set', seconds: Number($('duration').value) }));
for (const action of ['start', 'pause', 'reset', 'stop']) $(action).addEventListener('click', () => send({ type: 'timer', action }));
$('complete').addEventListener('click', () => send({ type: 'complete' }));
$('chat-form').addEventListener('submit', event => {
  event.preventDefault(); const text = $('message').value.trim();
  if (!text || !paired || stopped) return;
  send({ type: 'chat', text }); $('message').value = ''; $('message').style.height = ''; $('message').focus();
});
$('message').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } });
$('message').addEventListener('input', () => { $('message').style.height = 'auto'; $('message').style.height = `${Math.min(110, $('message').scrollHeight)}px`; });
window.addEventListener('pagehide', () => { send({ type: 'leave' }); socket?.close(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) send({ type: 'suspend' });
  else { lastReceived = Date.now(); send({ type: 'resume' }); send({ type: 'ping' }); }
});
window.addEventListener('offline', () => disconnect('オフラインになったため停止しました。'));
async function initializeOwner() {
  $('connect-button').disabled = true;
  try {
    if (ownerActivation) {
      const response = await fetch('/api/owner', { method: 'POST', headers: { Authorization: `Bearer ${ownerActivation}` } });
      if (!response.ok) throw new Error('管理者用リンクが無効です。');
    }
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (!response.ok) throw new Error('認証状態を確認できませんでした。再読み込みしてください。');
    owner = (await response.json()).owner === true;
    $('connect-button').disabled = !inviteId && !owner;
    if (!inviteId && !owner) {
      $('join-form').hidden = true; status('招待リンクから参加してください。');
    } else status(inviteId ? '名前を入力して参加してください。' : '管理者として接続しました。');
  } catch (error) { status(error.message, true); }
}
initializeOwner();
setInterval(renderTime, 250);
updateControls(); renderTime();
