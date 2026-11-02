// Test-only fake implementation of the pinned engine's public management/OneBot APIs.
const fs=require('fs'), path=require('path'), http=require('http'), crypto=require('crypto');
const {WebSocketServer}=require('ws');
const profile=process.env.WHALE_QQ_PROFILE, config=path.join(profile,'runtime/config');
const web=JSON.parse(fs.readFileSync(path.join(config,'webui.json'),'utf8'));
const wsConfig=JSON.parse(fs.readFileSync(path.join(config,'onebot11.json'),'utf8')).network.websocketServers[0];
fs.writeFileSync(path.join(profile,'storage-isolated.json'),'{"version":1}');
fs.writeFileSync(path.join(profile,'pid.json'),String(process.pid));
const state=()=>{try{return JSON.parse(fs.readFileSync(path.join(profile,'simulation.json'),'utf8'))}catch{return {}}};
// A new native process is logged out unless it reuses the selected saved account.
// Model persistence of login records without carrying a live rejected session.
const previous=state();
if(previous.login && web.autoLoginAccount!==previous.account)fs.writeFileSync(path.join(profile,'simulation.json'),JSON.stringify({...previous,login:false,qrcodeurl:'',loginPhase:'waiting_qrcode'}));
const server=http.createServer(async(req,res)=>{
  let input=''; for await(const chunk of req)input+=chunk;
  const body=JSON.parse(input||'{}'); let data={};
  const s=state();
  if(req.url==='/api/auth/login') {
    if(body.hash!==crypto.createHash('sha256').update(web.token+'.napcat').digest('hex')) {res.end('{"code":-1}');return;}
    data={Credential:'fake-private-credential'};
  } else {
    if(req.headers.authorization!=='Bearer fake-private-credential'){res.end('{"code":-1}');return;}
    if(req.url.endsWith('/CheckLoginStatus'))data={isLogin:!!s.login,qrcodeurl:s.qrcodeurl ?? 'https://example.invalid/qq-login-test',loginError:s.loginError || '',loginPhase:s.loginPhase};
    if(req.url.endsWith('/RefreshQRcode')) {
      data={qrcodeurl:'https://example.invalid/qq-login-refreshed'};
      fs.writeFileSync(path.join(profile,'simulation.json'),JSON.stringify({...s,...data}));
    }
    if(req.url.endsWith('/GetQQLoginInfo'))data={uin:s.account||'100001'};
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data}));
});server.listen(web.port,web.host);
const ws=new WebSocketServer({port:wsConfig.port,host:wsConfig.host,verifyClient:i=>i.req.headers.authorization==='Bearer '+wsConfig.token});
ws.on('connection',socket=>socket.on('message',raw=>{
  const packet=JSON.parse(raw.toString());const s=state();
  fs.appendFileSync(path.join(profile,'actions.jsonl'),JSON.stringify({action:packet.action})+'\n');
  socket.send(JSON.stringify({status:'ok',retcode:0,echo:packet.echo,data:packet.action==='get_login_info'?{user_id:s.account||'100001'}:{message_id:9000}}));
  if(packet.action==='get_login_info')setTimeout(()=>{if(socket.readyState===1)socket.send(JSON.stringify({post_type:'message',message_type:'private',sub_type:'friend',self_id:100001,user_id:200002,message_id:1,message:[{type:'text',data:{text:'托管组件测试'}}]}));},100);
}));
