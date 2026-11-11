'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const { Window, distribution, advice, report }=require('../app/performance.js');
test('performance window reports p95, keeps unknown values unknown, expires data and resets on route/codec changes',()=>{
 const window=new Window();
 for(let i=0;i<20;i++) window.observe({valid:true,routeId:'a',codec:'H264',width:1920,height:1080,rttMs:i<18?5:50,processingMs:2,jitterMs:null},'sender',null,i*1000);
 let summary=window.snapshot(19500); assert.equal(summary.rttMs.median,5); assert.equal(summary.rttMs.p95,50); assert.equal(summary.jitterMs.count,0);
 window.frame({presentationTime:120,receiveTime:100,processingDuration:.002},20000); window.frame({presentationTime:200,receiveTime:0},20001);
 assert.equal(window.snapshot(20000).receiveToPresentMs.median,20);
 window.observe({valid:true,routeId:'b',codec:'AV1',width:1920,height:1080,rttMs:7},'viewer',null,21000);
 summary=window.snapshot(21000); assert.equal(summary.count,1); assert.equal(summary.rttMs.p95,7); assert.equal(summary.receiveToPresentMs.count,0);
 assert.equal(window.snapshot(90000).count,0); assert.equal(distribution([null,undefined,Infinity,-1]).count,0);
});
test('report distinguishes Tailscale relay from inner UDP and never invents a total input delay',()=>{
 const window=new Window(),sample={valid:true,routeId:'vpn',codec:'H264',width:1920,height:1080,rttMs:60,processingMs:3,path:{network:'tailscale',rtcProtocol:'udp'},route:'P2P · udp · Tailscale'};
 for(let i=0;i<15;i++) window.observe(sample,'viewer',{processingMs:2},i*1000);
 const context={summary:window.snapshot(15000),role:'viewer',sample,host:{codec:'H264'},vpn:{path:'relay',reason:'DERP',region:'test'},profile:{fps:120}};
 assert.match(advice(context).join(' '),/DERP/); const text=report(context); assert.match(text,/Сетевая RTT: обычно 60/); assert.match(text,/не складываются/); assert.ok(!text.includes('username')); assert.ok(!text.includes('credential'));
});
