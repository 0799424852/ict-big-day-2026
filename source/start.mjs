import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {createEventApp} from './server.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const mode=process.argv.includes('--live')?'live':process.argv.includes('--trial')?'trial':'local';
const app=await createEventApp({root});
let tunnel=null,closing=false;
function open(url){if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',detached:true}).unref();}
const server=createServer(async(req,res)=>{
 try{
  const host=req.headers.host||'';
  const publicUrl=app.hostStatus().publicUrl;
  const base=host==='127.0.0.1:3000'?app.localOrigin:publicUrl&&host===new URL(publicUrl).host?publicUrl:null;
  if(!base){res.writeHead(421);res.end('Unknown website address');return;}
  const request=new Request(new URL(req.url,base),{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
  const response=await app.handle(request);
  res.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
 }catch(error){console.error('Request could not finish:',error.message);if(!res.headersSent)res.writeHead(500);res.end('Request could not finish.');}
});
server.headersTimeout=15000;server.requestTimeout=30000;server.maxHeadersCount=80;
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port 3000 is already in use. Close the other event launcher before trying again.':error.message);process.exitCode=1;app.close();});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3000,'127.0.0.1',resolve);}).catch(()=>process.exit(1));
console.log('\nICT BIG DAY 2026 — WINDOWS HOST\n');
console.log('Local website: '+app.localOrigin);
console.log('Host controls: '+app.localOrigin+'/host');
console.log('Keep this window open while people use the website. Press Ctrl+C to stop.\n');
if(!app.hostStatus().initialised){console.log('Create your administrator using this one-time setup link:\n'+app.setupUrl()+'\n');open(app.setupUrl());}
else open(app.localOrigin+'/host');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForOwner(){while(!closing&&!app.hostStatus().initialised)await delay(1000);return !closing;}
function cloudflaredPath(){
 const bundled=join(root,'tools','cloudflared.exe');if(existsSync(bundled))return bundled;
 const located=spawnSync(process.platform==='win32'?'where.exe':'which',['cloudflared'],{encoding:'utf8',windowsHide:true});
 return located.status===0?located.stdout.trim().split(/\r?\n/)[0]:null;
}
async function verifyPublic(url){
 console.log('Checking the public address...');
 for(let i=0;i<20&&!closing;i++){
  if(tunnel?.exitCode!==null&&tunnel?.exitCode!==undefined)break;
  try{const response=await fetch(url+'/api/health',{signal:AbortSignal.timeout(5000),redirect:'error'});const health=await response.json();if(response.ok&&health.instanceId===app.hostStatus().instanceId&&health.ready){
   app.markVerified();app.shareFiles(url);console.log('\nPUBLIC WEBSITE: '+url+'\nQR CODE: '+join(root,'share','ICT-Big-Day-QR.svg')+'\nSHARE PAGE: '+join(root,'share','SHARE.html')+'\n');
   console.log(mode==='trial'?'Temporary test link. A new tunnel creates a different link and QR code. Use a fixed address for the event.':'Your fixed public address passed its connection check. Test it on a phone using mobile data.');
   open(app.localOrigin+'/host');return true;
  }}catch{}
  await delay(2000);
 }
 console.error('The public connection could not be verified. The local website is still running. Check the tunnel settings and internet connection, then restart this launcher. A new share QR has not been created.');return false;
}
if(mode!=='local'){
 if(await waitForOwner()){
  const binary=cloudflaredPath();
  if(!binary)console.error('cloudflared is missing. Open START-HERE.html and install it, or place cloudflared.exe inside the tools folder. The website is available locally.');
  else if(mode==='live'&&(!app.config().publicUrl||!existsSync(join(app.dataDir,'tunnel-token.txt'))))console.error('A fixed tunnel has not been configured. Open Host controls and save your public HTTPS address and tunnel token, then restart START-LIVE.cmd. Use START-TRIAL-LINK.cmd only for a temporary test.');
  else{
   const argumentsList=mode==='live'?['tunnel','--no-autoupdate','run','--token-file',join(app.dataDir,'tunnel-token.txt')]:['tunnel','--no-autoupdate','--url',app.localOrigin];
   // A separate working directory avoids accidental use of this app's data as tunnel configuration.
   const tunnelDirectory=join(root,'tools');mkdirSync(tunnelDirectory,{recursive:true});
   tunnel=spawn(binary,argumentsList,{cwd:tunnelDirectory,stdio:['ignore','pipe','pipe'],windowsHide:true});
   let found=false,pending='',logs='';
   const observe=bytes=>{
    const text=bytes.toString();logs=(logs+text).slice(-16000);pending=(pending+text).slice(-8000);
    if(mode==='trial'&&!found){const match=pending.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);if(match){found=true;const url=app.setPublicUrl(match[0]);void verifyPublic(url);}}
    // Never echo tunnel credentials or full diagnostic headers to the console.
    if(/Registered tunnel connection/.test(text))console.log('Tunnel connected.');
   };
   tunnel.stdout.on('data',observe);tunnel.stderr.on('data',observe);
   tunnel.on('error',error=>console.error('Could not start cloudflared: '+error.message));
   tunnel.on('exit',code=>{if(!closing){console.error('The public tunnel stopped (code '+code+'). The website is still available locally. Restart the launcher to reconnect.');}});
   if(mode==='live'){app.setPublicUrl(app.config().publicUrl);void verifyPublic(app.config().publicUrl);}
   else {console.log('Creating a temporary test tunnel...');setTimeout(()=>{if(!found&&!closing)console.error('No temporary link was received. Check that cloudflared can connect. A pre-existing cloudflared config.yml can prevent Quick Tunnels; see START-HERE.html.');},30000).unref();}
  }
 }
}
async function stop(){if(closing)return;closing=true;console.log('\nStopping the public connection and website...');tunnel?.kill();server.close(async()=>{app.close();process.exit(0);});server.closeIdleConnections();setTimeout(()=>process.exit(0),5000).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
