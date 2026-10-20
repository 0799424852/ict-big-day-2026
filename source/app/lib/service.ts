import { programme, defaults, categories, rubric } from './programme.ts';
import type { Profile } from './types.ts';

export type Actor={userId:string;email:string;displayName:string};
import {AppError,id,now,stmt,all,one,text,pick,url,date,organiser,administrator,required,profileWithRoles,checkAttachmentOwnership,type Data} from './core.ts';
import {canOrganise,hasRole} from './permissions.ts';
import {actConference,readConferenceState,readPublicSubmissions,currentAssignment,checkConflict} from './conference.ts';
export {AppError} from './core.ts';

export async function initialiseProgramme(db:D1Database){
 const seeded=await one(db,"SELECT value FROM settings WHERE key='programme_seed_v1'");
 if(!seeded){await db.batch([
  ...Object.entries(defaults).map(([k,v])=>stmt(db,'INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)',k,v)),
  ...programme.map((p,i)=>stmt(db,'INSERT OR IGNORE INTO sessions (id,sort_order,start,end,title,category,lead,outcome) VALUES (?,?,?,?,?,?,?,?)',p[0],i,p[1],p[2],p[3],p[4],p[5],p[6])),
  stmt(db,"INSERT OR IGNORE INTO settings (key,value) VALUES ('programme_seed_v1','true')"),
 ]);}
 const revision=await one(db,"SELECT value FROM settings WHERE key='conference_setup_v3'");
 if(!revision)await db.batch([
  stmt(db,"UPDATE sessions SET lead=REPLACE(REPLACE(REPLACE(lead,'Mr Precious Leutle','Ms Precious Leutle'),'Mr. Precious Leutle','Ms Precious Leutle'),'Mr Leutle','Ms Leutle') WHERE lead LIKE '%Leutle%'"),
  ...['reviewing_open','abstracts_open','projects_open'].map(key=>stmt(db,'INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)',key,defaults[key])),
  stmt(db,"INSERT OR IGNORE INTO settings (key,value) VALUES ('conference_setup_v3','true')"),
 ]);
}
export async function prepare(db:D1Database,actor:Actor):Promise<Profile>{
 if(!actor.userId||!actor.email)throw new AppError('Please sign in to participate.',401);
 await initialiseProgramme(db);
 // Public visitors cannot claim the original private owner's permissions.
 const owner=await one(db,"SELECT value FROM settings WHERE key='workspace_owner'");
 if(!owner)throw new AppError('The organiser must finish setting up this event.',503);
 await stmt(db,'INSERT OR IGNORE INTO profiles (id,email,name,role,created_at) VALUES (?,?,?,?,?)',actor.userId,actor.email,actor.displayName,owner?.value===actor.userId?'administrator':'attendee',now()).run();
 await stmt(db,'UPDATE profiles SET email=? WHERE id=?',actor.email,actor.userId).run();
 if(owner.value===actor.userId)await stmt(db,"UPDATE profiles SET role='administrator' WHERE id=?",actor.userId).run();
 return profileWithRoles(db,actor.userId);
}

export async function readAttendance(db:D1Database){
 const result=await one(db,"WITH unique_participants AS (SELECT LOWER(TRIM(email)) AS participant,MAX(CASE WHEN attendance='in_person' THEN 1 ELSE 0 END) AS in_person,MAX(CASE WHEN checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS checked_in FROM profiles WHERE registered_at IS NOT NULL GROUP BY LOWER(TRIM(email))) SELECT COUNT(*) AS registered,COALESCE(SUM(checked_in),0) AS checkedIn,COALESCE(SUM(in_person),0) AS inPerson,COALESCE(SUM(1-in_person),0) AS online,COALESCE(SUM(checked_in*in_person),0) AS inPersonCheckedIn,COALESCE(SUM(checked_in*(1-in_person)),0) AS onlineCheckedIn FROM unique_participants");
 return {registered:Number(result?.registered||0),checkedIn:Number(result?.checkedIn||0),inPerson:Number(result?.inPerson||0),online:Number(result?.online||0),inPersonCheckedIn:Number(result?.inPersonCheckedIn||0),onlineCheckedIn:Number(result?.onlineCheckedIn||0)};
}
async function readStats(db:D1Database){
 const [attendance,other]=await Promise.all([readAttendance(db),one(db,"SELECT (SELECT COUNT(*) FROM projects WHERE status='approved') AS projects,(SELECT COUNT(*) FROM connections WHERE status IN ('accepted','in_progress','completed')) AS connections,(SELECT COUNT(*) FROM connections WHERE status='completed') AS completed,(SELECT COUNT(*) FROM feedback) AS feedback")]);
 return {...attendance,...other};
}
export async function readPublicState(db:D1Database){
 await initialiseProgramme(db);
 const [config,sessions,stats,library]=await Promise.all([all(db,"SELECT key,value FROM settings WHERE key NOT IN ('workspace_owner','programme_seed_v1')"),all(db,'SELECT * FROM sessions ORDER BY sort_order'),readStats(db),readPublicSubmissions(db)]);
 return {profile:null,settings:Object.fromEntries(config.filter(x=>x.key in defaults).map(x=>[x.key,x.value])),sessions,stats,...library,bookmarks:[],questions:[],opportunities:[],connections:[],scores:[],people:[],feedback:null,assignments:[],abstractReviews:[],attachments:[],roleGrants:[],accessGrants:[]};
}

export async function readState(db:D1Database,p:Profile){
 const admin=canOrganise(p);
 const [config,sessions,bookmarks,projects,questions,opportunities,connections,scores,people,feedback,counts]=await Promise.all([
  all(db,"SELECT key,value FROM settings WHERE key NOT IN ('workspace_owner','programme_seed_v1')"),
  all(db,'SELECT * FROM sessions ORDER BY sort_order'),
  all(db,'SELECT session_id FROM bookmarks WHERE user_id=?',p.id),
  all(db,`SELECT j.*,p.name AS owner_name,a.name AS attachment_name FROM projects j JOIN profiles p ON p.id=j.owner_id LEFT JOIN attachments a ON a.id=j.attachment_id WHERE ?=1 OR j.status='approved' OR j.owner_id=? ORDER BY j.created_at DESC`,admin?1:0,p.id),
  all(db,`SELECT q.*,p.name AS author, (SELECT COUNT(*) FROM votes WHERE question_id=q.id) AS votes,(SELECT COUNT(*) FROM votes WHERE question_id=q.id AND user_id=?) AS voted FROM questions q JOIN profiles p ON p.id=q.user_id WHERE ?=1 OR q.status IN ('published','answered') OR q.user_id=? ORDER BY votes DESC,q.created_at DESC`,p.id,admin?1:0,p.id),
  all(db,`SELECT o.*,p.name AS owner_name,p.organisation FROM opportunities o JOIN profiles p ON p.id=o.owner_id WHERE o.status='open' OR o.owner_id=? OR ?=1 ORDER BY o.created_at DESC`,p.id,admin?1:0),
  all(db,`SELECT c.*,f.name AS from_name,t.name AS to_name,f.email AS from_email,t.email AS to_email,f.share_contact AS from_share,t.share_contact AS to_share,j.title AS project_title,o.title AS opportunity_title FROM connections c JOIN profiles f ON f.id=c.from_id JOIN profiles t ON t.id=c.to_id LEFT JOIN projects j ON j.id=c.project_id LEFT JOIN opportunities o ON o.id=c.opportunity_id WHERE c.from_id=? OR c.to_id=? OR ?=1 ORDER BY c.created_at DESC`,p.id,p.id,admin?1:0),
  admin?all(db,'SELECT s.*,p.name AS judge_name FROM scores s JOIN profiles p ON p.id=s.judge_id JOIN projects j ON j.id=s.project_id WHERE s.submission_version=j.version'):hasRole(p,'judge')?all(db,'SELECT s.* FROM scores s JOIN projects j ON j.id=s.project_id WHERE s.judge_id=? AND s.submission_version=j.version',p.id):Promise.resolve([]),
  admin?all(db,'SELECT profiles.*,COALESCE(auth_users.email_verified,0) AS email_verified FROM profiles LEFT JOIN auth_users ON profiles.id=auth_users.id ORDER BY profiles.created_at DESC'):Promise.resolve([]),
  one(db,'SELECT learning,next_step,rating FROM feedback WHERE user_id=?',p.id),
  readStats(db),
 ]);
 const conference=await readConferenceState(db,p);
 return {...conference,profile:p,settings:{...defaults,...Object.fromEntries(config.filter(x=>x.key in defaults).map(x=>[x.key,x.value]))},sessions,bookmarks:bookmarks.map(x=>x.session_id),projects,
  questions:questions.map(q=>({...q,author:q.anonymous?(admin?q.author+' (anonymous to participants)':q.user_id===p.id?'You (anonymous)':'Anonymous participant'):q.author,user_id:admin||q.user_id===p.id?q.user_id:undefined})),opportunities,
  connections:connections.map(c=>{const accepted=['accepted','in_progress','completed'].includes(c.status);return {...c,from_email:accepted&&c.from_share?c.from_email:undefined,to_email:accepted&&c.to_share?c.to_email:undefined,from_share:undefined,to_share:undefined};}),
  scores,people:people.map(person=>({...person,roles:[...new Set([person.role,...conference.roleGrants.filter(g=>g.user_id===person.id).map(g=>g.role),...conference.accessGrants.filter(g=>g.email===String(person.email).trim().toLowerCase()&&person.email_verified===1).map(g=>g.role)])]})),feedback,stats:counts};
}

export async function act(db:D1Database,p:Profile,d:Data){
 const action=text(d,'action',1,40);
 if(action==='register'){
  const name=text(d,'name',2,100),organisation=text(d,'organisation',0,160),attendance=pick(d,'attendance',['in_person','online']);
  const interests=text(d,'interests',0,300),goal=text(d,'goal',0,1000),share=d.share_contact===true?1:0;
  const pass=p.pass_code||crypto.randomUUID().replaceAll('-','').slice(0,8).toUpperCase();
  await stmt(db,'UPDATE profiles SET name=?,organisation=?,attendance=?,interests=?,goal=?,share_contact=?,registered_at=COALESCE(registered_at,?),pass_code=? WHERE id=?',name,organisation,attendance,interests,goal,share,now(),pass,p.id).run();
 } else if(action==='bookmark'){
  const sid=text(d,'session_id',1,80);await required(db,'sessions',sid);
  const exists=await one(db,'SELECT id FROM bookmarks WHERE user_id=? AND session_id=?',p.id,sid);
  if(exists)await stmt(db,'DELETE FROM bookmarks WHERE user_id=? AND session_id=?',p.id,sid).run();else await stmt(db,'INSERT OR IGNORE INTO bookmarks (id,user_id,session_id) VALUES (?,?,?)',id(),p.id,sid).run();
 } else if(action==='project'){
  const pid=typeof d.id==='string'?d.id:'';if(pid){const existing=await required(db,'projects',pid);if(existing.owner_id!==p.id)throw new AppError('You can edit only your own projects.',403);}
  const person=await required(db,'profiles',p.id);if(!person.registered_at)throw new AppError('Complete event registration before submitting a project.');
  const window=await one(db,"SELECT value FROM settings WHERE key='projects_open'");if(window?.value==='false')throw new AppError('Project submissions are currently closed.');
  const attachment=await checkAttachmentOwnership(db,typeof d.attachment_id==='string'?d.attachment_id:null,p.id),consent=d.public_consent===true?1:0;
  const title=text(d,'title',3,160),team=text(d,'team',2,160),category=pick(d,'category',categories),problem=text(d,'problem',15,2000),solution=text(d,'solution',15,2000),stage=pick(d,'stage',['Idea','Prototype','Working demo']),support=text(d,'support',2,500),demo=url(text(d,'demo_url',0,1500)),business=text(d,'business_model',0,1500);
  if(pid){
   await stmt(db,"UPDATE projects SET title=?,team=?,category=?,problem=?,solution=?,stage=?,support=?,demo_url=?,business_model=?,attachment_id=?,public_consent=?,version=version+1,award='',status='pending' WHERE id=?",title,team,category,problem,solution,stage,support,demo,business,attachment,consent,pid).run();
  }else await stmt(db,'INSERT INTO projects (id,owner_id,title,team,category,problem,solution,stage,support,demo_url,business_model,status,created_at,attachment_id,public_consent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id(),p.id,title,team,category,problem,solution,stage,support,demo,business,'pending',now(),attachment,consent).run();
 } else if(action==='moderate_project'){
  organiser(p);const pid=text(d,'id',1,100);await required(db,'projects',pid);const status=pick(d,'status',['pending','approved','declined']);
  await stmt(db,'UPDATE projects SET status=? WHERE id=?',status,pid).run();
 } else if(action==='award'){
  organiser(p);const pid=text(d,'id',1,100),award=text(d,'award',0,120);const project=await required(db,'projects',pid);if(project.status!=='approved')throw new AppError('Approve the project before announcing an award.');
  await stmt(db,'UPDATE projects SET award=? WHERE id=?',award,pid).run();
 } else if(action==='question'){
  const sid=text(d,'session_id',1,80);if(sid!=='general')await required(db,'sessions',sid);
  await stmt(db,'INSERT INTO questions (id,user_id,session_id,body,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?)',id(),p.id,sid,text(d,'body',10,1000),d.anonymous===true?1:0,'pending',now()).run();
 } else if(action==='vote'){
  const qid=text(d,'id',1,100),q=await required(db,'questions',qid);if(!['published','answered'].includes(q.status))throw new AppError('This question is not open for voting.');
  const exists=await one(db,'SELECT id FROM votes WHERE user_id=? AND question_id=?',p.id,qid);
  if(exists)await stmt(db,'DELETE FROM votes WHERE user_id=? AND question_id=?',p.id,qid).run();else await stmt(db,'INSERT OR IGNORE INTO votes (id,user_id,question_id) VALUES (?,?,?)',id(),p.id,qid).run();
 } else if(action==='moderate_question'){
  organiser(p);const qid=text(d,'id',1,100);await required(db,'questions',qid);const status=pick(d,'status',['pending','published','answered','hidden']),answer=text(d,'answer',0,2000);if(status==='answered'&&!answer)throw new AppError('Add the answer before marking this question answered.');
  await stmt(db,'UPDATE questions SET status=?,answer=? WHERE id=?',status,answer,qid).run();
 } else if(action==='opportunity'){
  await stmt(db,'INSERT INTO opportunities (id,owner_id,kind,title,details,status,created_at) VALUES (?,?,?,?,?,?,?)',id(),p.id,pick(d,'kind',['Offering mentorship','Seeking mentorship','Project partnership','Community challenge','Internship or opportunity']),text(d,'title',5,160),text(d,'details',15,2000),'open',now()).run();
 } else if(action==='close_opportunity'){
  const oid=text(d,'id',1,100),item=await required(db,'opportunities',oid);if(item.owner_id!==p.id&&!canOrganise(p))throw new AppError('Only the author can close this opportunity.',403);
  await stmt(db,'UPDATE opportunities SET status=? WHERE id=?',pick(d,'status',['open','closed']),oid).run();
 } else if(action==='connect'){
  const projectId=typeof d.project_id==='string'?d.project_id:'',opportunityId=typeof d.opportunity_id==='string'?d.opportunity_id:'';
  if((!!projectId)===(!!opportunityId))throw new AppError('Choose one project or opportunity.');
  const target=await required(db,projectId?'projects':'opportunities',projectId||opportunityId);
  if(projectId&&target.status!=='approved')throw new AppError('This project is not available for collaboration.');
  if(opportunityId&&target.status!=='open')throw new AppError('This opportunity has closed.');
  if(target.owner_id===p.id)throw new AppError('You cannot send a collaboration request to yourself.');
  const existing=await one(db,"SELECT id FROM connections WHERE from_id=? AND to_id=? AND (project_id=? OR opportunity_id=?) AND status!='declined'",p.id,target.owner_id,projectId||null,opportunityId||null);
  if(existing)throw new AppError('You already have an active request for this item.');
  await stmt(db,'INSERT INTO connections (id,from_id,to_id,project_id,opportunity_id,message,created_at) VALUES (?,?,?,?,?,?,?)',id(),p.id,target.owner_id,projectId||null,opportunityId||null,text(d,'message',10,1500),now()).run();
 } else if(action==='update_connection'){
  const cid=text(d,'id',1,100),c=await required(db,'connections',cid);if(c.from_id!==p.id&&c.to_id!==p.id&&!canOrganise(p))throw new AppError('This collaboration belongs to other participants.',403);
  const status=pick(d,'status',['accepted','declined','in_progress','completed']);
  if(c.status==='pending'&&c.to_id!==p.id)throw new AppError('The recipient must accept or decline this request.',403);
  const allowed:Record<string,string[]>={pending:['accepted','declined'],accepted:['accepted','in_progress','completed'],in_progress:['in_progress','completed'],completed:['completed'],declined:[]};
  if(!allowed[c.status]?.includes(status))throw new AppError('That status change is not available.');
  const next=text(d,'next_action',0,1000),due=date(text(d,'due_date',0,10));if(['accepted','in_progress'].includes(status)&&(!next||!due))throw new AppError('Agree a next action and a follow-up date.');
  await stmt(db,'UPDATE connections SET status=?,next_action=?,due_date=? WHERE id=?',status,next,due,cid).run();
 } else if(action==='score'){
  if(!hasRole(p,'judge'))throw new AppError('Only assigned judges can submit scores.',403);
  const config=await one(db,"SELECT value FROM settings WHERE key='judging_open'");if(config?.value!=='true')throw new AppError('Judging is currently closed.');
  const pid=text(d,'project_id',1,100),project=await required(db,'projects',pid);if(project.status!=='approved')throw new AppError('Only approved projects can be scored.');await checkConflict(db,p,project);const assignment=await currentAssignment(db,p,'project',project);if(d.no_conflict!==true)throw new AppError('Confirm that you have no conflict of interest before judging.');
  const values=rubric.map(([key])=>{const v=d[key];if(typeof v!=='number'||!Number.isInteger(v)||v<1||v>5)throw new AppError('Score every criterion from 1 to 5.');return v;});
  await stmt(db,'INSERT INTO scores (id,judge_id,project_id,relevance,innovation,feasibility,business,impact,feedback,updated_at,submission_version) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(judge_id,project_id,submission_version) DO UPDATE SET relevance=excluded.relevance,innovation=excluded.innovation,feasibility=excluded.feasibility,business=excluded.business,impact=excluded.impact,feedback=excluded.feedback,updated_at=excluded.updated_at',id(),p.id,pid,...values,text(d,'feedback',0,1500),now(),project.version).run();
  await stmt(db,"UPDATE assignments SET status='completed' WHERE id=?",assignment.id).run();
 } else if(action==='role'){
  administrator(p);const uid=text(d,'id',1,100),role=pick(d,'role',['attendee','judge','reviewer','organiser','administrator']);await required(db,'profiles',uid);const owner=await one(db,"SELECT value FROM settings WHERE key='workspace_owner'");if(uid===owner?.value&&role!=='administrator')throw new AppError('The workspace owner must remain an administrator.');await stmt(db,'UPDATE profiles SET role=? WHERE id=?',role,uid).run();
 } else if(action==='attend_online'){
  const profile=await required(db,'profiles',p.id);
  if(!profile.registered_at)throw new AppError('Complete registration before confirming your attendance.');
  if(profile.attendance!=='online')throw new AppError('In-person participants check in with the registration team.');
  const stage=await one(db,"SELECT value FROM settings WHERE key='stage'");
  if(stage?.value!=='live')throw new AppError('Online check-in opens when the event goes live.');
  await stmt(db,'UPDATE profiles SET checked_in_at=COALESCE(checked_in_at,?) WHERE id=?',now(),p.id).run();
 } else if(action==='checkin'){
  organiser(p);const code=text(d,'code',1,100).toUpperCase();const person=await one(db,'SELECT id FROM profiles WHERE UPPER(pass_code)=? AND registered_at IS NOT NULL',code);if(!person)throw new AppError('No registration matches that entry code.',404);await stmt(db,'UPDATE profiles SET checked_in_at=COALESCE(checked_in_at,?) WHERE id=?',now(),person.id).run();
 } else if(action==='settings'){
  organiser(p);const values=d.values;if(!values||typeof values!=='object'||Array.isArray(values))throw new AppError('Invalid event settings.');const v=values as Data,updates:[string,string][]=[];
  for(const k of Object.keys(v)){if(!(k in defaults))throw new AppError('Unknown event setting.');let value=text(v,k,0,k==='announcement'?2000:1500);if(k==='stream_url')value=url(value);if(k==='date'){if(!value)throw new AppError('Choose an event date.');value=date(value);}if(['start','end'].includes(k)&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new AppError('Use a valid event time.');if(k==='stage'&&!['upcoming','live','closed'].includes(value))throw new AppError('Invalid event stage.');if(['judging_open','reviewing_open','projects_open','abstracts_open'].includes(k)&&!['true','false'].includes(value))throw new AppError('Invalid judging setting.');if(['event_title','venue','theme'].includes(k)&&!value)throw new AppError('Event title, venue and theme cannot be empty.');updates.push([k,value]);}
  const config=Object.fromEntries((await all(db,'SELECT key,value FROM settings')).map(x=>[x.key,x.value]));const merged={...config,...Object.fromEntries(updates)};if(merged.end<=merged.start)throw new AppError('The event end time must be after its start.');
  await db.batch(updates.map(([k,value])=>stmt(db,'UPDATE settings SET value=? WHERE key=?',value,k)));
 } else if(action==='session'){
  organiser(p);const sid=text(d,'id',1,100);await required(db,'sessions',sid);const start=text(d,'start',0,5),end=text(d,'end',0,5);for(const t of [start,end])if(t&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(t))throw new AppError('Use valid session times.');if(Boolean(start)!==Boolean(end)||start&&end<=start)throw new AppError('Add both times, with the end after the start.');
  await stmt(db,'UPDATE sessions SET title=?,lead=?,start=?,end=?,outcome=? WHERE id=?',text(d,'title',3,200),text(d,'lead',2,1200),start,end,text(d,'outcome',5,1500),sid).run();
 } else if(action==='feedback'){
  const rating=d.rating;if(typeof rating!=='number'||!Number.isInteger(rating)||rating<1||rating>5)throw new AppError('Choose a rating from 1 to 5.');
  await stmt(db,'INSERT INTO feedback (user_id,learning,next_step,rating,created_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET learning=excluded.learning,next_step=excluded.next_step,rating=excluded.rating,created_at=excluded.created_at',p.id,text(d,'learning',10,1500),text(d,'next_step',10,1500),rating,now()).run();
 } else if(action==='export'){
  organiser(p);const dataset=pick(d,'dataset',['registrations','projects','collaborations','judging','feedback']);
  const queries:Record<string,string>={registrations:'SELECT name,email,organisation,attendance,interests,goal,registered_at,checked_in_at,pass_code FROM profiles WHERE registered_at IS NOT NULL',projects:'SELECT title,team,category,problem,solution,stage,support,demo_url,business_model,status,award FROM projects',collaborations:'SELECT f.name AS from_name,t.name AS to_name,c.message,c.status,c.next_action,c.due_date FROM connections c JOIN profiles f ON f.id=c.from_id JOIN profiles t ON t.id=c.to_id',judging:'SELECT j.title,p.name AS judge,s.relevance,s.innovation,s.feasibility,s.business,s.impact,s.feedback FROM scores s JOIN profiles p ON p.id=s.judge_id JOIN projects j ON j.id=s.project_id',feedback:'SELECT p.name,f.learning,f.next_step,f.rating,f.created_at FROM feedback f JOIN profiles p ON p.id=f.user_id'};
  return {rows:await all(db,queries[dataset])};
 } else {const result=await actConference(db,p,d);if(result!==undefined)return result;throw new AppError('Unknown action.');}
 return {ok:true};
}
