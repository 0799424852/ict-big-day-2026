import {readFileSync,writeFileSync,mkdirSync,existsSync,statSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {openStore} from './store.mjs';
import {authStore,token,digest} from './auth.mjs';
import {prepare,readState,readPublicState,readAttendance,act,initialiseProgramme,AppError} from './app/lib/service.ts';
import {mayReadAttachment} from './app/lib/file-access.ts';
import {readPdfUpload} from './app/lib/pdf-upload.ts';
import {canAdminister} from './app/lib/permissions.ts';
import {qrSvg} from './qr.ts';

const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const safeReturn=value=>typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//')&&!/[\\\u0000-\u001f]/.test(value)&&!value.startsWith('/auth/')?value:'/#participation';
const portals={attendee:'participation',participant:'submissions',judge:'judging',reviewer:'reviewing',organiser:'organiser',administrator:'administrator'};
const json=(body,status=200)=>Response.json(body,{status});
const redirect=(url,headers={})=>new Response(null,{status:303,headers:{Location:url,...headers}});
function page(title,content){return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ICT Big Day</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/assets/host.css"></head><body><main class="host"><a class="brand" href="/">ICT BIG DAY<span>.</span></a>${content}</main></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});}
const field=(name,label,type='text',value='',extra='')=>`<label>${escape(label)}<input name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`;
const submit=label=>`<button type="submit">${label}</button>`;

export async function createEventApp({root,dataDir=join(root,'data'),shareDir=join(root,'share'),localOrigin='http://127.0.0.1:3000'}){
 const store=openStore(dataDir,join(root,'migrations')),auth=authStore(store.sql);
 const files=join(dataDir,'uploads');mkdirSync(files,{recursive:true,mode:0o700});
 const configPath=join(dataDir,'hosting.json');
 let config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
 let publicOrigin=config.publicUrl||null,publicVerified=false,setupToken=token(),activeHashes=0;
 const instancePath=join(dataDir,'instance-id.txt');
 if(!existsSync(instancePath))writeFileSync(instancePath,token(),{mode:0o600});
 const instanceId=readFileSync(instancePath,'utf8').trim();
 await store.exclusive(()=>initialiseProgramme(store.db));
 const actor=user=>({userId:user.id,email:user.email,displayName:user.name});
 function cookieName(secure){return secure?'__Host-ict_session':'ict_session_local';}
 function cookieValue(request,secure){const prefix=cookieName(secure)+'=';return (request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(prefix))?.slice(prefix.length);}
 function sessionCookie(value,secure,clear=false){return cookieName(secure)+'='+value+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+(clear?0:86400)+(secure?'; Secure':'');}
 async function fields(request){
  const kind=request.headers.get('content-type')||'';let value='';
  const reader=request.body?.getReader();if(!reader)throw new AppError('Empty request.');
  const chunks=[];let length=0;
  while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>24000){await reader.cancel();throw new AppError('This request is too large.',413);}chunks.push(part.value);}
  value=Buffer.concat(chunks).toString('utf8');
  if(kind.includes('application/json')){try{const parsed=JSON.parse(value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}catch{throw new AppError('Invalid request.');}}
  if(kind.includes('application/x-www-form-urlencoded'))return Object.fromEntries(new URLSearchParams(value));
  throw new AppError('Unsupported request type.',415);
 }
 async function hashing(operation){if(activeHashes>=4)throw new AppError('Sign-in is busy. Please try again in a moment.',429);activeHashes++;try{return await operation();}finally{activeHashes--;}}
 function formPage(mode,returnTo='',extra=''){
  const signup=mode==='signup',setup=mode==='setup',reset=mode==='reset';
  const title=setup?'Set up your event administrator':signup?'Create your event account':reset?'Choose a new password':'Sign in to your event account';
  const action=setup?'/host/setup':reset?'/auth/reset':'/auth/'+mode;
  const content=`<p class="eyebrow">MAKE YOUR PARTICIPATION COUNT</p><h1>${title}</h1>${extra}<form method="post" action="${action}"><input type="hidden" name="return_to" value="${escape(returnTo)}">${setup?field('setup_token','','hidden',setupToken):''}${reset?field('token','','hidden',returnTo):''}${signup||setup?field('name','Full name','text','','required minlength="2" maxlength="100" autocomplete="name"'):''}${reset?'':field('email','Email address','email','','required maxlength="254" autocomplete="email"')}${field('password',reset||signup||setup?'Password · at least 12 characters':'Password','password','','required '+(signup||setup||reset?'minlength="12" maxlength="128" autocomplete="new-password"':'maxlength="128" autocomplete="current-password"'))}${submit(setup?'Create administrator':signup?'Create account':reset?'Save password':'Sign in')}</form>${setup||reset?'':`<p>${signup?'Already have an account?':'New to ICT Big Day?'} <a href="/auth/${signup?'signin':'signup'}?return_to=${encodeURIComponent(returnTo)}">${signup?'Sign in':'Create an account'}</a></p><p class="muted">Forgotten your password? Ask the organiser for a password reset link. No email is sent automatically.</p>`}<p class="muted">${signup?'After creating your account, complete event registration to appear in the live attendance counter.':''}</p>`;
  return page(title,content);
 }
 function validatePublicUrl(value){const url=new URL(String(value));if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port)throw new AppError('Use your public HTTPS address without a path or port.');return url.origin;}
 function setPublicUrl(value,verified=false){publicOrigin=validatePublicUrl(value);publicVerified=verified;return publicOrigin;}
 function hostStatus(){return {initialised:!!auth.ownerId(),publicUrl:publicOrigin,verified:publicVerified,instanceId};}
 function shareFiles(url){
  const directory=shareDir;mkdirSync(directory,{recursive:true});
  const svg=qrSvg(url);writeFileSync(join(directory,'ICT-Big-Day-QR.svg'),svg);writeFileSync(join(directory,'PUBLIC-LINK.txt'),url+'\n');
  writeFileSync(join(directory,'SHARE.html'),`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ICT Big Day · Make your participation count</title><style>body{font:20px system-ui;text-align:center;max-width:760px;margin:60px auto;padding:24px;color:#172735}h1{font-size:42px}img{max-width:90%;width:440px}a{overflow-wrap:anywhere}small{display:block;margin-top:24px}</style><h1>ICT BIG DAY 2026</h1><p>University of Mpumalanga · 23 October 2026</p><h2>Make your participation count.</h2><p>Scan to register, explore the programme and take part.</p><img src="ICT-Big-Day-QR.svg" alt="QR code to the ICT Big Day website"><p><a href="${escape(url)}">${escape(url)}</a></p><small>Hosted on the organiser’s PC. Availability depends on the PC and its internet connection.</small></html>`);
 }
 async function route(request){
  const url=new URL(request.url),secure=url.protocol==='https:',isLocal=url.origin===localOrigin&&!request.headers.has('cf-ray')&&!request.headers.has('x-forwarded-for');
  if(url.origin!==localOrigin&&url.origin!==publicOrigin)throw new AppError('Unknown website address.',421);
  if(!['GET','HEAD','POST'].includes(request.method))throw new AppError('Method not allowed.',405);
  if(request.method==='POST'&&request.headers.get('origin')!==url.origin)throw new AppError('Submit this request from the event website.',403);
  const value=cookieValue(request,secure),user=auth.authenticate(value);
  const profile=user?await store.exclusive(()=>prepare(store.db,actor(user))):null;
  const manager=canAdminister(profile);
  const requireUser=()=>{if(!user)throw new AppError('Please sign in.',401);};
  const requireAdmin=()=>{if(!manager)throw new AppError('Administrator access is required.',403);};
  const requireLocal=()=>{if(!isLocal)throw new AppError('Open Host controls on the hosting PC.',403);};
  const path=url.pathname;
  const assets={'/assets/app.js':['assets/app.js','text/javascript; charset=utf-8'],'/assets/app.css':['assets/app.css','text/css; charset=utf-8'],'/assets/host.css':['assets/host.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml'],'/ict-big-day-draft-programme.docx':['ict-big-day-draft-programme.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document']};
  if(assets[path]&&(request.method==='GET'||request.method==='HEAD')){const [file,mime]=assets[path];return new Response(readFileSync(join(root,'public',file)),{headers:{'Content-Type':mime}});}
  if(path==='/api/health')return json({ok:true,instanceId,ready:!!auth.ownerId()});
  if(path==='/host/setup'){
   requireLocal();if(auth.ownerId())return redirect('/host');
   if(request.method==='GET'){if(url.searchParams.get('token')!==setupToken)throw new AppError('Use the setup link displayed in the launcher.',403);return formPage('setup');}
   const input=await fields(request);if(!input.setup_token||digest(input.setup_token)!==digest(setupToken))throw new AppError('Invalid setup link.',403);
   auth.limit('setup',10);const owner=await hashing(()=>auth.create(input,true));setupToken=token();
   await store.exclusive(()=>prepare(store.db,actor(owner)));return redirect('/host',{'Set-Cookie':sessionCookie(auth.session(owner.id),secure)});
  }
  if(!auth.ownerId())return page('Event setup',`<h1>The organiser is setting up ICT Big Day.</h1><p>Please check back shortly.</p>`);
  if(path==='/auth/signin'||path==='/auth/signup'){
   const mode=path.endsWith('signup')?'signup':'signin',returnTo=safeReturn(url.searchParams.get('return_to'));
   if(request.method==='GET')return user?redirect(returnTo):formPage(mode,returnTo);
   const input=await fields(request),email=String(input.email||'');
   const ip=isLocal?'local':request.headers.get('cf-connecting-ip')||'public';
   auth.limit('auth-ip:'+ip,100);auth.limit(mode+':'+email.trim().toLowerCase(),12);
   const account=await hashing(()=>mode==='signup'?auth.create(input):auth.login(email,input.password||''));
   await store.exclusive(()=>prepare(store.db,actor(account)));
   return redirect(safeReturn(input.return_to),{'Set-Cookie':sessionCookie(auth.session(account.id),secure)});
  }
  if(path==='/auth/signout'){
   if(request.method==='GET')return page('Sign out',`<h1>Sign out of ICT Big Day?</h1><form method="post">${field('return_to','','hidden',safeReturn(url.searchParams.get('return_to')))}${submit('Sign out')}</form><p><a href="/">Keep me signed in</a></p>`);
   const input=await fields(request);auth.logout(value);return redirect(safeReturn(input.return_to),{'Set-Cookie':sessionCookie('',secure,true)});
  }
  if(path==='/auth/reset'){
   if(request.method==='GET'){if(!auth.resetValid(url.searchParams.get('token')))throw new AppError('This reset link has expired or was already used.');return formPage('reset',url.searchParams.get('token'));}
   const input=await fields(request);auth.limit('reset:'+String(input.token).slice(0,100),8);await hashing(()=>auth.changePassword(input.token,input.password));return redirect('/auth/signin');
  }
  if(path==='/api/attendance')return json({stats:await store.exclusive(()=>readAttendance(store.db)),updatedAt:new Date().toISOString()});
  if(path==='/api/platform'){
   if(request.method==='GET')return json(await store.exclusive(()=>profile?readState(store.db,profile):readPublicState(store.db)));
   requireUser();if(!request.headers.get('content-type')?.includes('application/json'))throw new AppError('Expected JSON.',415);
   const input=await fields(request);return json(await store.exclusive(async()=>act(store.db,await prepare(store.db,actor(user)),input)));
  }
  if(path==='/api/files'&&request.method==='POST'){
   requireUser();if(!profile.registered_at)throw new AppError('Complete event registration before uploading.');
   const file=await readPdfUpload(request),id=crypto.randomUUID(),name=file.name.replace(/[\\/\u0000-\u001f]/g,'_').slice(0,180),key=id+'.pdf';
   writeFileSync(join(files,key),Buffer.from(await file.arrayBuffer()),{flag:'wx',mode:0o600});
   try{await store.exclusive(()=>store.db.prepare('INSERT INTO attachments (id,owner_id,name,object_key,size,created_at) VALUES (?,?,?,?,?,?)').bind(id,user.id,name,key,file.size,new Date().toISOString()).run());}
   catch(error){unlinkSync(join(files,key));throw error;}
   return json({id,name,size:file.size},201);
  }
  if(path.startsWith('/api/files/')&&request.method==='GET'){
   const file=await store.exclusive(()=>mayReadAttachment(store.db,path.slice(11),profile));
   if(!file||!/^[a-f0-9-]+\.pdf$/.test(file.object_key)||!existsSync(join(files,file.object_key)))throw new AppError('Document not found.',404);
   return new Response(readFileSync(join(files,file.object_key)),{headers:{'Content-Type':'application/pdf','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name)}});
  }
  if(path==='/host/tunnel'&&request.method==='POST'){
   requireLocal();requireAdmin();const input=await fields(request),publicUrl=validatePublicUrl(input.public_url),tunnelToken=String(input.tunnel_token||'').trim();
   if(!/^[A-Za-z0-9_+=\/-]{30,4096}$/.test(tunnelToken))throw new AppError('Paste only the tunnel token from Cloudflare, not the whole command.');
   writeFileSync(join(dataDir,'tunnel-token.txt'),tunnelToken,{mode:0o600});config={publicUrl};writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});
   return page('Tunnel saved','<h1>Your fixed address is configured.</h1><p>Close the launcher, then run <strong>START-LIVE.cmd</strong>. It will connect the tunnel, check your public address and create the QR code.</p><p><a href="/host">Back to Host controls</a></p>');
  }
  if(path==='/host/accounts'&&request.method==='POST'){
   requireAdmin();const input=await fields(request),target=auth.account(String(input.user_id));if(!target)throw new AppError('Account not found.',404);
   if(input.action==='verify'){store.sql.prepare('UPDATE auth_users SET email_verified=1 WHERE id=?').run(target.id);return redirect('/host');}
   if(input.action==='reset'){
    const reset=auth.reset(target.id),link=(publicOrigin||localOrigin)+'/auth/reset?token='+reset;
    return page('Password reset',`<h1>Password reset for ${escape(target.name)}</h1><p>Give this link only to the verified account holder. It expires in 30 minutes and works once.</p><textarea readonly rows="4">${escape(link)}</textarea><p><a href="/host">Back to Host controls</a></p>`);
   }
   throw new AppError('Unknown account action.');
  }
  if(path==='/host'){
   if(!user)return redirect('/auth/signin?return_to=%2Fhost');requireAdmin();
   const accounts=store.sql.prepare('SELECT id,email,name,email_verified FROM auth_users ORDER BY created_at DESC').all();
   const rows=accounts.map(account=>`<tr><td>${escape(account.name)}<small>${escape(account.email)}</small></td><td>${account.email_verified?'Confirmed by organiser':`<form action="/host/accounts" method="post">${field('user_id','','hidden',account.id)}${field('action','','hidden','verify')}${submit('Confirm email ownership')}</form>`}</td><td><form action="/host/accounts" method="post">${field('user_id','','hidden',account.id)}${field('action','','hidden','reset')}${submit('Password reset link')}</form></td></tr>`).join('');
   return page('Host controls',`<p class="eyebrow">WINDOWS HOSTING</p><h1>Your event, live from your PC.</h1><nav><a href="/portal/administrator">Administrator workspace</a><a href="/portal/organiser">Organiser workspace</a><a href="/">Event website</a><a href="/auth/signout">Sign out</a></nav><section><h2>Public link and QR code</h2>${publicOrigin?`<p class="status">${publicVerified?'Public address checked successfully':'Public address has not passed its connection check yet'}</p><p><a href="${escape(publicOrigin)}" target="_blank" rel="noreferrer">${escape(publicOrigin)}</a></p><img class="qr" src="/host/qr.svg" alt="Event website QR code"><p><a href="/host/qr.svg" download="ICT-Big-Day-QR.svg">Download QR code</a></p><p>The <strong>share</strong> folder also contains the QR code, the link and a printable share page.</p>`:'<p>The website is running on this PC. A public tunnel is not connected yet.</p>'}<p>Keep this PC awake, online and connected to power. Keep the launcher window open.</p></section>${isLocal?`<section><h2>Connect a fixed public address</h2><p>For event use, create a Cloudflare Tunnel and a public hostname pointing to <strong>${escape(localOrigin)}</strong>. See START-HERE.html for the steps. Paste its hostname and tunnel token below. The token stays on this PC.</p><form method="post" action="/host/tunnel">${field('public_url','Public website address','url',config.publicUrl||'','required placeholder="https://your-event.your-domain.org"')}${field('tunnel_token','Cloudflare tunnel token','password','','required autocomplete="off"')}${submit('Save fixed address')}</form></section>`:''}<section><h2>Event accounts</h2><p>Only confirm email ownership after checking the person through a trusted channel. Email-based staff grants remain inactive until confirmation. You can also grant a role directly to the correct existing account in the Administrator workspace.</p><div class="scroll"><table><thead><tr><th>Account</th><th>Email confirmation</th><th>Recovery</th></tr></thead><tbody>${rows}</tbody></table></div></section><p class="muted">This is a separate installation. The existing hosted website and its records are not copied into this database.</p>`);
  }
  if(path==='/host/qr.svg'){requireAdmin();if(!publicOrigin)throw new AppError('Connect the public link first.');return new Response(qrSvg(publicOrigin),{headers:{'Content-Type':'image/svg+xml','Content-Disposition':'attachment; filename="ICT-Big-Day-QR.svg"'}});}
  if(path==='/'||path.startsWith('/portal/')){
   if(path.startsWith('/portal/')){if(!portals[path.split('/')[2]]||path.split('/').length!==3)throw new AppError('Workspace not found.',404);if(!user)return redirect('/auth/signin?return_to='+encodeURIComponent(path));}
   return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="ICT Big Day 2026 at the University of Mpumalanga. Make your participation count."><title>ICT Big Day 2026 · Make your participation count</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
  }
  throw new AppError('Page not found.',404);
 }
 async function handle(request){
  let response;try{response=await route(request);}catch(error){
   const status=error instanceof AppError?error.status:Number(error.status)||500;
   const message=status<500?error.message:'We could not complete this request. Please try again.';
   if(status>=500)console.error('Event request failed:',error.message);
   response=new URL(request.url).pathname.startsWith('/api/')?json({error:message},status):page('Please try again',`<h1>${escape(message)}</h1><p><a href="/auth/signin">Return to sign in</a></p><p><a href="/">Go to the event website</a></p>`);
   if(!new URL(request.url).pathname.startsWith('/api/'))response=new Response(response.body,{status,headers:response.headers});
  }
  const headers=new Headers(response.headers);
  headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');headers.set('X-Frame-Options','DENY');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers});
 }
 return {handle,store,auth,config:()=>config,hostStatus,setPublicUrl,markVerified:()=>{publicVerified=true;},shareFiles,setupUrl:()=>localOrigin+'/host/setup?token='+setupToken,localOrigin,dataDir,close:()=>store.close()};
}
