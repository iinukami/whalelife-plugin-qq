import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, cp, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fixture, until } from './fixture.ts';
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
async function fakeEngine(root:string) {
  const base=join(root,'vendor/napcat'); await mkdir(base,{recursive:true});
  await cp(process.execPath,join(base,'node.exe'));
  await cp(resolve('tests/fake-managed.cjs'),join(base,'index.js'));
  await writeFile(join(base,'wrapper.node'),'not-a-native-library-test-only');
  await writeFile(join(base,'package.json'),'{"type":"commonjs"}');
  await mkdir(join(base,'napcat')); await writeFile(join(base,'napcat/napcat.mjs'),'// test marker');
  const files:Record<string,string>={};
  for(const name of ['node.exe','index.js','wrapper.node','package.json','napcat/napcat.mjs']) files[name]=createHash('sha256').update(await readFile(join(base,name))).digest('hex');
  await writeFile(join(root,'vendor/engine-manifest.json'),JSON.stringify({version:'4.18.41',platform:'win32-x64',files}));
}
const profile=(root:string)=>join(root,'plugins/qq/data/managed-napcat');
async function waitLogin(f:Awaited<ReturnType<typeof fixture>>) {
  await until(async()=> (await f.status()).state==='waiting_login',15000);
  return Number(await readFile(join(profile(f.root),'pid.json'),'utf8'));
}
test('managed login QR is authenticated, tokens stay private, disable cancels engine and preserves settings', {timeout:25000},async t=>{
  const f=await fixture(t,{config:{connectionMode:'managed',accountId:''},preparePlugin:fakeEngine});
  const pid=await waitLogin(f);
  const status=await f.status();assert.match(status.engine.qrCode,/^data:image\/png;base64,/);
  assert.equal((await fetch(f.url+'/plugins/qq/status')).status,401);
  const publicResponse=await(await f.request('/plugins/qq/config')).json();
  const privateWeb=JSON.parse(await readFile(join(profile(f.root),'runtime/config/webui.json'),'utf8'));
  assert.ok(!JSON.stringify(publicResponse).includes(privateWeb.token));
  assert.equal((await f.request('/plugins/qq/refresh-qr',{})).status,200);
  assert.equal((await f.save({enabled:false})).status,200);
  await until(()=>!alive(pid));assert.equal((await f.status()).state,'disabled');
  assert.equal((await f.configFile()).connectionMode,'managed');
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(),'alive');
});
test('managed login enters actual channel, stop/restart removes engine and does not replay private messages', {timeout:30000},async t=>{
  const f=await fixture(t,{config:{connectionMode:'managed'},preparePlugin:fakeEngine});
  const pid=await waitLogin(f);
  const firstWeb=JSON.parse(await readFile(join(profile(f.root),'runtime/config/webui.json'),'utf8'));
  assert.equal(firstWeb.autoLoginAccount,'', 'first login must require QR even with an expected account configured');
  await writeFile(join(profile(f.root),'simulation.json'),'{"login":true,"account":"100001"}');
  await until(async()=>(await f.status()).state==='online',10000);
  await until(()=>f.generations.length===1);
  await until(async()=> (await readFile(join(profile(f.root),'actions.jsonl'),'utf8')).includes('send_private_msg'));
  await f.app.runtime.action('qq','stop');await until(()=>!alive(pid));
  assert.equal((await f.request('/plugins/qq/settings')).status,404);
  await f.app.runtime.action('qq','start');
  await until(async()=>(await f.status()).state==='online',12000);
  const reusedWeb=JSON.parse(await readFile(join(profile(f.root),'runtime/config/webui.json'),'utf8'));
  assert.equal(reusedWeb.autoLoginAccount,'100001', 'only this plugin\'s previous successful login may auto-login');
  await new Promise(r=>setTimeout(r,300));assert.equal(f.generations.length,1);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(),'alive');
});
test('wrong scans automatically return to QR without allowing the wrong account to chat', {timeout:30000},async t=>{
  const f=await fixture(t,{config:{connectionMode:'managed'},preparePlugin:fakeEngine});
  let pid=await waitLogin(f);
  const original=await f.configFile(), file=join(profile(f.root),'simulation.json');
  for (const wrong of ['999999','999998']) {
    await writeFile(file,JSON.stringify({login:true,account:wrong}));
    await until(()=>!alive(pid));
    await until(async()=>{const s=await f.status();return s.state==='waiting_login'&&s.engine.qrCode&&s.engine.loginNotice},12000);
    const s=await f.status();assert.match(s.engine.loginNotice,/QQ 100001.*重新扫码/);assert.equal(s.error,'');
    const nextPid=await waitLogin(f);assert.notEqual(nextPid,pid);pid=nextPid;
    assert.equal(f.generations.length,0);await assert.rejects(access(join(profile(f.root),'actions.jsonl')));
    await assert.rejects(access(join(profile(f.root),'identity.json')));
    assert.deepEqual(await f.configFile(),original);
    const web=JSON.parse(await readFile(join(profile(f.root),'runtime/config/webui.json'),'utf8'));assert.equal(web.autoLoginAccount,'');
    assert.equal((await f.request('/plugins/qq/refresh-qr',{})).status,200);
  }
  assert.equal(f.app.runtime.records.get('qq')?.status,'active');
  await writeFile(file,'{"login":true,"account":"100001"}');
  await until(async()=>(await f.status()).state==='online',10000);await until(()=>f.generations.length===1);
  assert.equal((await f.status()).engine.loginNotice,undefined);
  await until(async()=>(await readFile(join(profile(f.root),'actions.jsonl'),'utf8')).includes('send_private_msg'));
});
test('missing owned bundle fails locally; plugin can switch back to external mode', {timeout:20000},async t=>{
  const f=await fixture(t,{config:{connectionMode:'managed'}});
  await until(async()=>(await f.status()).state==='failed');
  assert.equal(f.app.runtime.records.get('qq')?.status,'active');
  assert.equal((await f.save({connectionMode:'external'})).status,200);
  await f.online();f.send();await until(()=>f.generations.length===1);
});
test('tampered engine is rejected before executable launch', {timeout:20000},async t=>{
  const f=await fixture(t,{config:{connectionMode:'managed'},preparePlugin:async root=>{
    await fakeEngine(root);await writeFile(join(root,'vendor/napcat/index.js'),'throw Error("tampered")');
  }});
  await until(async()=>(await f.status()).state==='failed');
  assert.match((await f.status()).error,/校验失败/);
  await assert.rejects(access(join(profile(f.root),'pid.json')));
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(),'alive');
});
test('disable while preparing/startup leaves no late engine process', {timeout:20000},async t=>{
  const f=await fixture(t,{config:{connectionMode:'managed'},preparePlugin:fakeEngine});
  assert.equal((await f.save({enabled:false})).status,200);
  await new Promise(r=>setTimeout(r,1800));
  let pid=0;try{pid=Number(await readFile(join(profile(f.root),'pid.json'),'utf8'))}catch{}
  assert.ok(!pid||!alive(pid));assert.equal((await f.status()).state,'disabled');
});
test('auto-detected account is pinned across logout and subsequent QR login', {timeout:25000},async t=>{
  const f=await fixture(t,{config:{connectionMode:'managed',accountId:''},preparePlugin:fakeEngine});
  const pid=await waitLogin(f), file=join(profile(f.root),'simulation.json');
  await writeFile(file,'{"login":true,"account":"100001"}');
  await until(async()=>(await f.status()).state==='online',10000);
  await until(()=>f.generations.length===1);
  await writeFile(file,'{"login":false}');
  await until(async()=>(await f.status()).state==='waiting_login');
  await until(async()=>!!(await f.status()).engine.qrCode);
  await writeFile(file,'{"login":true,"account":"999999"}');
  await until(()=>!alive(pid));
  await until(async()=>{const s=await f.status();return s.state==='waiting_login'&&s.engine.qrCode},12000);
  assert.equal(f.generations.length,1);assert.equal((await f.status()).engine.accountId,'100001');
  assert.equal(JSON.parse(await readFile(join(profile(f.root),'identity.json'),'utf8')).accountId,'100001');
  assert.equal((await f.configFile()).accountId,'');
  await writeFile(file,'{"login":true,"account":"100001"}');
  await until(async()=>(await f.status()).state==='online',10000);
  assert.equal(f.generations.length,1);
});

test('disabling during wrong-account recovery cancels the replacement process', {timeout:25000},async t=>{
  const f=await fixture(t,{config:{connectionMode:'managed'},preparePlugin:fakeEngine});
  const pid=await waitLogin(f);
  await writeFile(join(profile(f.root),'simulation.json'),'{"login":true,"account":"999999"}');
  await until(async()=>!!(await f.status()).engine.loginNotice);
  assert.equal((await f.save({enabled:false})).status,200);
  await until(()=>!alive(pid));await new Promise(r=>setTimeout(r,2200));
  const lastPid=Number(await readFile(join(profile(f.root),'pid.json'),'utf8'));
  assert.ok(!alive(lastPid));assert.equal((await f.status()).state,'disabled');assert.equal(f.generations.length,0);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(),'alive');
});

test('missing or invalidated QR shows login errors and clears stale images before recovery', {timeout:25000},async t=>{
  const f=await fixture(t,{config:{connectionMode:'managed'},preparePlugin:async root=>{
    await fakeEngine(root);const dir=join(root,'data/managed-napcat');await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'simulation.json'),JSON.stringify({qrcodeurl:'',loginError:'当前账号(100001)已登录,无法重复登录'}));
  }});
  await waitLogin(f);let status=await f.status();
  assert.equal(status.engine.qrCode,undefined);assert.match(status.error,/无法重复登录/);
  assert.ok(!status.error.includes('100001'));assert.equal(f.generations.length,0);
  const file=join(profile(f.root),'simulation.json');
  await writeFile(file,'{}');await until(async()=>!!(await f.status()).engine.qrCode);
  status=await f.status();assert.equal(status.error,'');
  await writeFile(file,'{"qrcodeurl":""}');await until(async()=>!(await f.status()).engine.qrCode);
  await writeFile(file,'{}');await until(async()=>!!(await f.status()).engine.qrCode);
  assert.equal((await f.request('/plugins/qq/refresh-qr',{})).status,200);
  assert.equal(await f.app.runtime.services.get('witness')!.value.ping(),'alive');
});
