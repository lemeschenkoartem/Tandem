'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const { tailscaleIP,parsePing,parsePeer,probe }=require('../app/tailscale.cjs');
test('Tailscale detection and ping summary handle relay-to-direct transitions and missing pings',()=>{
 assert.equal(tailscaleIP('100.90.1.2'),true); assert.equal(tailscaleIP('100.1.1.2'),false); assert.equal(tailscaleIP('100.90.1.2 & whoami'),false); assert.equal(tailscaleIP('fd7a:115c:a1e0::1'),true);
 const ping=parsePing('pong from peer (100.90.1.2) via DERP(fra) in 90ms\npong from peer (100.90.1.2) via 203.0.113.1:41641 in 5ms\npong from peer (100.90.1.2) via 203.0.113.1:41641 in 6ms\n');
 assert.equal(ping.lastPath,'direct'); assert.equal(ping.relaySamples,1); assert.equal(ping.medianMs,6); assert.equal(ping.p95Ms,90); assert.equal(parsePing('timeout').medianMs,null);
 assert.equal(parsePing('pong from peer via unknown-relay in 5ms').lastPath,'unknown');
 const status={Peer:{one:{TailscaleIPs:['100.90.1.2'],Active:true,CurAddr:'203.0.113.1:41641',Relay:'fra'}}};
 assert.equal(parsePeer(status,'100.90.1.2').path,'direct'); status.Peer.one.CurAddr=''; assert.equal(parsePeer(status,'100.90.1.2').path,'relay'); status.Peer.one.Active=false; assert.equal(parsePeer(status,'100.90.1.2').path,'unknown');
});
test('native probe uses fixed read-only commands without a shell and does not return the full private status payload',async()=>{
 const calls=[];
 const result=await probe('100.90.1.2',{platform:'win32',findBinary:()=>'/fixed/tailscale.exe',run:async(exe,args,options)=>{
 calls.push({exe,args,options});
 return {stdout:args[0]==='ping'?'pong from peer (100.90.1.2) via DERP(test) in 50ms\n':JSON.stringify({PrivateKey:'must-not-return',Peer:{one:{TailscaleIPs:['100.90.1.2'],Active:true,Relay:'test'}}})};
 }});
 assert.equal(result.path,'relay'); assert.equal(result.ping.medianMs,50); assert.equal(calls[0].options.shell,false); assert.deepEqual(calls[1].args,['status','--json']); assert.ok(!JSON.stringify(result).includes('must-not-return'));
 await assert.rejects(probe('100.90.1.2; rm -rf /'),/адреса Tailscale/);
 assert.equal((await probe('100.90.1.2',{platform:'linux'})).available,false);
});
