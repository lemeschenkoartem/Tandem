'use strict';
// Shared invitation format. Contains only a server address, public ID and network ID.
// No password, session token or TURN credentials are included.
(() => {
  function normalizeServer(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Укажите адрес сервера: ws://IP:8787 или wss://домен.'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new Error('Укажите ws://IP:8787 или wss://домен без пути, пароля и параметров.');
    const h = url.hostname;
    const privateIP = /^(127\.|10\.|192\.168\.|169\.254\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
    // Radmin VPN uses the 26/8 overlay range; it is not an RFC1918 range.
    const radminOverlay = /^26\./.test(h);
    if (url.protocol === 'ws:' && !privateIP && !radminOverlay && h !== 'localhost' && !h.endsWith('.ts.net') && !h.endsWith('.local')) throw new Error('Для публичного сервера используйте wss://. Для VPN — адрес Tailscale или Radmin VPN.');
    return url.href.replace(/\/$/, '');
  }
  function validateInvitation(value) {
    if (!value || value.v !== 1 || typeof value.id !== 'string' || !/^[0-9]{8}$/.test(value.id) || typeof value.network !== 'string' || !/^[a-f0-9]{32}$/.test(value.network)) throw new Error('Приглашение повреждено. Попросите друга скопировать его заново.');
    return { id: value.id, server: normalizeServer(value.server), network: value.network };
  }
  function createInvitation(value) {
    const data = validateInvitation({ v: 1, ...value });
    return 'tandem://connect/' + btoa(JSON.stringify({ v: 1, ...data })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function parseTarget(text) {
    text = typeof text === 'string' ? text.trim() : '';
    const id = text.replace(/[\s-]/g, '');
    if (/^[0-9]{8}$/.test(id)) return { id };
    const prefix = 'tandem://connect/';
    if (!text.startsWith(prefix) || text.length > 4096) throw new Error('Введите ID друга из 8 цифр или вставьте полное приглашение tandem://connect/…');
    let value;
    try { value = JSON.parse(atob(text.slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/'))); }
    catch { throw new Error('Приглашение повреждено. Попросите друга скопировать его заново.'); }
    return validateInvitation(value);
  }
  const exported = { normalizeServer, createInvitation, parseTarget };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else globalThis.TandemNetwork = exported;
})();
