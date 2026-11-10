'use strict';
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Accounts } = require('./accounts.cjs');

function createRelay({ port = 8787, host = '0.0.0.0', maxRooms = 1000, databasePath = ':memory:' } = {}) {
  const accounts = new Accounts(databasePath);
  const rooms = new Map();
  const limits = new Map();
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(req.url === '/health' ? { ok: true, service: 'tandem-relay' } : { error: 'Not found' }));
  });
  const wss = new WebSocketServer({ server, maxPayload: 256 * 1024, perMessageDeflate: false });
  const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const fail = (ws, message, code = 'REQUEST_FAILED', request) => send(ws, { type: 'error', message, code, request });
  function remove(ws) {
    const room = rooms.get(ws.roomId);
    if (!room) { ws.roomId = undefined; ws.role = undefined; return; }
    if (room.host === ws) {
      rooms.delete(ws.roomId);
      send(room.guest, { type: 'ended' });
      send(room.pending, { type: 'ended' });
      for (const peer of [room.guest, room.pending]) if (peer) { peer.roomId = undefined; peer.role = undefined; }
    } else if (room.guest === ws) {
      room.guest = null;
      send(room.host, { type: 'peer-left' });
    } else if (room.pending === ws) {
      room.pending = null; send(room.host, { type: 'request-cancelled' });
    }
    ws.roomId = undefined; ws.role = undefined;
  }
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    let state = limits.get(ip);
    if (!state) {
      if (limits.size >= 4096) { ws.close(1013, 'Busy'); return; }
      state = { connections: 0, creates: 0, authAttempts: 0, start: Date.now() }; limits.set(ip, state);
    }
    if (++state.connections > 20) { state.connections--; ws.close(1008, 'Too many connections'); return; }
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    send(ws, { type: 'hello', protocol: 3, network: accounts.networkId });
    let windowStart = Date.now(), messages = 0;
    ws.on('message', async raw => {
      if (Date.now() - windowStart > 1000) { windowStart = Date.now(); messages = 0; }
      if (++messages > 120) { ws.close(1008, 'Rate limit'); return; }
      let msg;
      try { msg = JSON.parse(raw); } catch { fail(ws, 'Некорректное сообщение.'); return; }
      if (!msg || typeof msg !== 'object') return;
      if (['register', 'login', 'resume'].includes(msg.type)) {
        if (ws.authBusy || ws.account) return fail(ws, 'Запрос уже обрабатывается.');
        if (Date.now() - state.start > 60000) { state.start = Date.now(); state.creates = 0; state.authAttempts = 0; }
        if (msg.type !== 'resume' && ++state.authAttempts > 10) return fail(ws, 'Слишком много попыток входа. Подождите минуту.');
        ws.authBusy = true;
        try {
          const resumed = msg.type === 'resume' ? accounts.resume(msg.token) : null;
          if (msg.type === 'resume' && !resumed) { fail(ws, 'Сохранённый вход истёк. Войдите заново.', 'SESSION_EXPIRED', msg.type); return; }
          const account = resumed?.account || (msg.type === 'register' ? await accounts.register(msg.name, msg.password) : await accounts.login(msg.name, msg.password));
          const hash = resumed ? accounts.sessionHash(msg.token) : null;
          for (const client of wss.clients) {
            if (client === ws || client.readyState !== WebSocket.OPEN || client.account?.id !== account.id) continue;
            if (hash && client.sessionHash === hash) { remove(client); client.close(4001, 'Session resumed'); }
            else { fail(ws, 'Этот аккаунт открыт на другом клиенте. Используйте отдельный аккаунт друга.', 'ACCOUNT_IN_USE', msg.type); return; }
          }
          ws.account = account;
          const saved = resumed ? { token: msg.token, expires: resumed.expires } : accounts.createSession(account.name);
          ws.sessionHash = accounts.sessionHash(saved.token);
          send(ws, { type: 'authenticated', account: ws.account, network: accounts.networkId, ...saved });
        } catch (error) { fail(ws, error.message, 'AUTH_FAILED', msg.type); }
        finally { ws.authBusy = false; }
        return;
      }
      if (!ws.account) return fail(ws, 'Сначала войдите в аккаунт.', 'AUTH_REQUIRED', msg.type);
      if (msg.type === 'create') {
        if (ws.roomId) return fail(ws, 'Вы уже в комнате.', 'ALREADY_IN_ROOM', msg.type);
        if (Date.now() - state.start > 60000) { state.start = Date.now(); state.creates = 0; state.authAttempts = 0; }
        if (++state.creates > 12 || rooms.size >= maxRooms) return fail(ws, 'Лимит комнат. Попробуйте позже.', 'RATE_LIMITED', msg.type);
        const room = randomBytes(12).toString('hex');
        rooms.set(room, { host: ws, guest: null, pending: null, created: Date.now() });
        ws.roomId = room; ws.role = 'host';
        send(ws, { type: 'created', id: ws.account.id });
      } else if (msg.type === 'find' || msg.type === 'join-id') {
        if (Date.now() - (ws.lookupStart || 0) > 60000) { ws.lookupStart = Date.now(); ws.lookups = 0; }
        if (++ws.lookups > 30) return fail(ws, 'Слишком много запросов поиска. Подождите минуту.', 'RATE_LIMITED', msg.type);
        if (ws.roomId) return fail(ws, 'Вы уже в сети.', 'ALREADY_IN_ROOM', msg.type);
        if (typeof msg.id !== 'string' || !/^[0-9]{8}$/.test(msg.id)) return fail(ws, 'ID должен содержать 8 цифр.', 'INVALID_ID', msg.type);
        if (msg.id === ws.account.id) return fail(ws, 'Это ваш собственный ID. Введите ID друга.', 'OWN_ID', msg.type);
        const account = accounts.find(msg.id);
        if (!account) return fail(ws, 'Аккаунт с таким ID отсутствует на этом сервере. Попросите друга прислать приглашение с адресом его сети.', 'ID_NOT_FOUND', msg.type);
        const entry = [...rooms.entries()].find(([, room]) => room.host.account.id === msg.id);
        if (msg.type === 'find') { send(ws, { type: 'found', account, online: Boolean(entry), busy: Boolean(entry?.[1].guest || entry?.[1].pending) }); return; }
        if (!entry) return fail(ws, 'Друг сейчас не принимает подключения. Попросите его войти и нажать «Создать сеть».', 'PEER_OFFLINE', msg.type);
        const [roomId, room] = entry;
        if (room.guest || room.pending) return fail(ws, 'В этой сети уже есть друг или заявка.', 'ROOM_BUSY', msg.type);
        room.pending = ws; ws.role = 'pending'; ws.roomId = roomId;
        send(ws, { type: 'join-pending' }); send(room.host, { type: 'join-request', name: ws.account.name, id: ws.account.id });
      } else if (msg.type === 'accept-peer' || msg.type === 'reject-peer') {
        const room = rooms.get(ws.roomId);
        if (!room || room.host !== ws || !room.pending) return;
        const guest = room.pending; room.pending = null;
        if (msg.type === 'reject-peer') { guest.roomId = undefined; guest.role = undefined; send(guest, { type: 'rejected' }); return; }
        room.guest = guest; guest.role = 'guest';
        send(guest, { type: 'joined', name: ws.account.name }); send(ws, { type: 'peer-joined', name: guest.account.name });
      } else if (msg.type === 'signal') {
        const room = rooms.get(ws.roomId);
        if (!room || !room.guest || ws.role === 'pending') return fail(ws, 'Сначала дождитесь подтверждения подключения.');
        const data = msg.data;
        if (!data || !['offer', 'answer', 'ice'].includes(data.kind)) return;
        // Either approved participant may originate a stream after a role swap.
        send(ws.role === 'host' ? room.guest : room.host, { type: 'signal', data });
      } else if (msg.type === 'leave') {
        remove(ws); send(ws, { type: 'left' });
      } else if (msg.type === 'logout') {
        remove(ws); accounts.revokeSession(ws.sessionHash); ws.account = undefined; ws.sessionHash = undefined;
        send(ws, { type: 'logged-out' });
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => { state.connections--; remove(ws); });
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive || (!ws.account && !ws.roomId && Date.now() - (ws.connectedAt ??= Date.now()) > 5 * 60000)) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
    for (const [ip, state] of limits) if (!state.connections && Date.now() - state.start > 60000) limits.delete(ip);
  }, 15000);
  timer.unref();
  return {
    server, rooms, accounts,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise(resolve => {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => server.close(() => { accounts.close(); resolve(); }));
    })
  };
}
module.exports = { createRelay };
