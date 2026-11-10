'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { format, error, iceError } = require('../app/logging.js'); const { Logger } = require('../app/logger.cjs');
test('readable log lines have time, level and Russian explanation, with no payload/secret fields or newline injection', () => {
 const line = format('direct_offer', { reason: 'строка\nвторая строка', password: 'secret-value', token: 'private-token', sdp: 'secret-sdp', candidate: 'private-ip', action: 'tandem://direct/private-data', result: 'credential="private-password"' }, new Date('2026-11-10T17:00:00Z'));
 assert.match(line, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \| ИНФО \| Приглашение создано/);
 assert.equal(line.split('\n').length, 2); for (const secret of ['secret-value','private-token','secret-sdp','private-data','private-password','private-ip']) assert.ok(!line.includes(secret));
 assert.match(error(new SyntaxError('JSON {"credential":"secret"}')), /Некорректный формат/);
 assert.match(iceError(701), /Не удалось обратиться/); assert.match(iceError(401), /отклонил данные/);
 assert.match(error(new Error("Error invoking remote method 'test': Error: Не удалось открыть журнал.")), /Не удалось открыть журнал/);
});
test('UTF-8 log persists ordered events, flushes at close and rotates bounded archives', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-logs-')), filename = path.join(directory, 'tandem.log');
 try {
  const logger = new Logger(filename, { maxBytes: 400, backups: 2 });
  logger.record('start', { version: '0.3.1' }); logger.record('direct_offer'); await logger.flush();
  const first = fs.readFileSync(filename, 'utf8'); assert.ok(first.indexOf('Приложение запущено') < first.indexOf('Приглашение создано'));
  for (let i=0;i<5;i++) { logger.record('ice_error', { code: 701, reason: iceError(701) }); await logger.flush(); }
  logger.record('stop'); await logger.close();
  assert.match(fs.readFileSync(filename,'utf8'), /Приложение закрывается/); assert.ok(fs.existsSync(filename+'.1')); assert.ok(fs.existsSync(filename+'.2')); assert.ok(!fs.existsSync(filename+'.3'));
 } finally { fs.rmSync(directory, { recursive:true, force:true }); }
});
test('TURN settings require actual relay credentials and relay mode cannot silently use STUN', () => {
 const { iceConfiguration } = require('../app/network.js');
 assert.throws(() => iceConfiguration([{urls:'stun:example.com:3478'}], 'relay'), /TURN-сервер ещё не задан/);
 assert.throws(() => iceConfiguration([{urls:'turn:example.com:3478'}], 'relay'), /username и credential/);
 assert.throws(() => iceConfiguration([{urls:'https://example.com?apiKey=secret'}]), /Адрес ICE/);
 const config = iceConfiguration([{urls:['turn:example.com:3478?transport=udp','turns:example.com:443?transport=tcp'],username:'test',credential:'not-a-real-secret'}], 'relay');
 assert.equal(config.iceTransportPolicy,'relay'); assert.equal(config.iceServers[0].urls.length,2);
});
