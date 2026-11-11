'use strict';
const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
const { execFile } = require('node:child_process'); const { promisify } = require('node:util');
function tailscaleIP(ip) { return typeof ip === 'string' && ((net.isIP(ip) === 4 && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) || (net.isIP(ip) === 6 && /^fd7a:115c:a1e0:/i.test(ip))); }
function percentile(values, p) { if (!values.length) return null; const sorted = [...values].sort((a,b) => a-b); return Math.round(sorted[Math.ceil(p*sorted.length)-1] * 10) / 10; }
function parsePing(output) {
 const samples = String(output).split(/\r?\n/).map(line => {
  const time = line.match(/\bin\s+([\d.]+)\s*(ms|s)\s*$/i); if (!time) return null;
  const relay = line.match(/via\s+DERP\(([^)]+)\)/i);
  const direct = /\bvia\s+(?:(?:\d{1,3}\.){3}\d{1,3}:\d+|\[[0-9a-f:]+\]:\d+)/i.test(line);
  return { ms: Number(time[1]) * (time[2].toLowerCase() === 's' ? 1000 : 1), path: relay ? 'relay' : direct ? 'direct' : 'unknown', region: relay?.[1] || null };
 }).filter(value => value && Number.isFinite(value.ms) && value.ms >= 0 && value.ms < 60000);
 return { count: samples.length, medianMs: percentile(samples.map(v=>v.ms), .5), p95Ms: percentile(samples.map(v=>v.ms), .95), lastPath: samples.at(-1)?.path || 'unknown', relaySamples: samples.filter(v=>v.path==='relay').length, directSamples: samples.filter(v=>v.path==='direct').length, region: samples.at(-1)?.region || null };
}
function parsePeer(status, ip) {
 const peer = Object.values(status.Peer || {}).find(value => Array.isArray(value.TailscaleIPs) && value.TailscaleIPs.includes(ip));
 if (!peer) return { path: 'unknown', reason: 'Этот адрес не найден среди участников Tailscale на данном ПК.' };
 // A home DERP region alone does not prove relaying. CurAddr is checked first.
 if (peer.CurAddr) return { path: 'direct', reason: 'Tailscale сообщает о прямом пути между ПК.' };
 if (peer.Active && peer.Relay) return { path: 'relay', region: String(peer.Relay).replace(/[^a-z0-9-]/gi,'').slice(0,32), reason: 'Tailscale сообщает об активном пути через DERP-ретранслятор.' };
 return { path: 'unknown', reason: 'Tailscale не подтвердил текущий путь; нужен активный обмен пакетами.' };
}
function binary() {
 const directories = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
 for (const directory of directories) { const filename = path.join(directory, 'Tailscale', 'tailscale.exe'); if (fs.existsSync(filename)) return filename; }
 return null;
}
async function probe(ip, { platform = process.platform, run = promisify(execFile), findBinary = binary } = {}) {
 if (!tailscaleIP(ip)) throw new Error('Проверка Tailscale доступна для выбранного адреса Tailscale 100.x или fd7a:115c:a1e0::. Сначала установите трансляцию через него.');
 const at = new Date().toISOString();
 if (platform !== 'win32') return { at, available:false, path:'unknown', reason:'Проверка Tailscale выполняется в Windows-клиенте.' };
 const exe = findBinary();
 if (!exe) return { at, available:false, path:'unknown', reason:'Не найден tailscale.exe. Проверьте установку официального клиента Tailscale.' };
 const options = { timeout:14000, maxBuffer:2*1024*1024, windowsHide:true, encoding:'utf8', shell:false };
 let pings;
 try { const result = await run(exe, ['ping','--c=5','--timeout=2s','--until-direct=false',ip], options); pings = parsePing(result.stdout); }
 catch (error) { pings = parsePing(error.stdout || ''); }
 let status;
 try { const result = await run(exe, ['status','--json'], { ...options, timeout:5000 }); status = parsePeer(JSON.parse(result.stdout), ip); }
 catch { status = { path:'unknown', reason:'Не удалось получить состояние службы Tailscale. Проверьте, запущена ли она.' }; }
 const pathKind = pings.count && pings.lastPath !== 'unknown' ? pings.lastPath : status.path;
 return { at, available:true, path:pathKind, reason:pathKind==='direct' ? 'Подтверждён прямой путь Tailscale.' : pathKind==='relay' ? 'Путь проходит через DERP. Проверьте возможность прямого UDP на обоих ПК; один город не исключает удалённый ретранслятор.' : status.reason, region:pings.region || status.region || null, ping:pings, note:'Это сетевой тест Tailscale на момент проверки. Полная задержка управления в него не входит.' };
}
module.exports = { tailscaleIP, parsePing, parsePeer, probe };
