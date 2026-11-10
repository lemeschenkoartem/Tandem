'use strict';
const fs = require('node:fs');
const path = require('node:path');
const validId = value => typeof value === 'string' && /^[0-9]{8}$/.test(value);
class SocialStore {
  constructor(filename = null) {
    this.filename = filename; this.state = { version: 1, friends: [], requests: [] };
    if (filename && fs.existsSync(filename)) {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.friends) || !Array.isArray(value.requests)) throw new Error('Некорректный файл контактов сервера.');
      this.state = value;
    }
  }
  save() {
    if (!this.filename) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(this.filename + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
  }
  areFriends(a, b) { return this.state.friends.some(f => (f.a === a && f.b === b) || (f.a === b && f.b === a)); }
  request(from, to) {
    if (!validId(from) || !validId(to) || from === to) throw new Error('Укажите ID другого аккаунта.');
    if (this.areFriends(from, to)) return;
    if (this.state.requests.some(r => r.from === to && r.to === from)) throw new Error('У вас уже есть входящая заявка от этого пользователя. Примите её в списке.');
    if (this.state.requests.some(r => r.from === from && r.to === to)) return;
    if (this.state.requests.filter(r => r.from === from || r.to === from).length >= 50 || this.state.requests.filter(r => r.to === to).length >= 50) throw new Error('Достигнут лимит заявок в друзья.');
    this.state.requests.push({ from, to, at: Date.now() }); this.save();
  }
  decide(actor, from, accept) {
    const request = this.state.requests.find(r => r.from === from && r.to === actor);
    if (!request) throw new Error('Заявка уже обработана или отсутствует.');
    if (accept) {
      for (const id of [actor, from]) if (this.state.friends.filter(f => f.a === id || f.b === id).length >= 100) throw new Error('Лимит — 100 друзей.');
      if (!this.areFriends(actor, from)) this.state.friends.push({ a: from, b: actor, at: Date.now() });
    }
    this.state.requests = this.state.requests.filter(r => r !== request); this.save();
  }
  remove(actor, id) {
    this.state.friends = this.state.friends.filter(f => !((f.a === actor && f.b === id) || (f.a === id && f.b === actor)));
    this.state.requests = this.state.requests.filter(r => !((r.from === actor && r.to === id) || (r.from === id && r.to === actor))); this.save();
  }
  snapshot(id, account, presence) {
    const describe = friendId => { const user = account(friendId); return user ? { ...user, ...presence(friendId) } : null; };
    return {
      friends: this.state.friends.filter(f => f.a === id || f.b === id).map(f => describe(f.a === id ? f.b : f.a)).filter(Boolean),
      incoming: this.state.requests.filter(r => r.to === id).map(r => describe(r.from)).filter(Boolean),
      outgoing: this.state.requests.filter(r => r.from === id).map(r => describe(r.to)).filter(Boolean),
    };
  }
}
module.exports = { SocialStore };
