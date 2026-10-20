import type {Profile} from './types.ts';
import {categories,abstractRubric} from './programme.ts';
import {canOrganise,canAdminister,hasRole,privilegedRoles} from './permissions.ts';
import {AppError,id,now,stmt,all,one,text,pick,required,organiser,administrator,profileWithRoles,checkAttachmentOwnership,type Data} from './core.ts';

export async function readPublicSubmissions(db:D1Database){
 const [projects,abstracts]=await Promise.all([
  all(db,"SELECT j.id,'' AS owner_id,j.title,j.team,j.category,j.problem,j.solution,j.stage,j.support,j.demo_url,j.business_model,j.status,j.award,j.created_at,j.attachment_id,j.public_consent,j.version,j.team AS owner_name,a.name AS attachment_name FROM projects j LEFT JOIN attachments a ON a.id=j.attachment_id WHERE j.status='approved' AND j.public_consent=1 ORDER BY j.created_at DESC"),
  all(db,"SELECT s.id,'' AS owner_id,s.title,s.authors,s.affiliations,s.category,s.keywords,s.body,s.presentation,s.project_id,s.attachment_id,s.public_consent,s.status,s.version,s.award,s.created_at,s.updated_at,a.name AS attachment_name FROM abstracts s LEFT JOIN attachments a ON a.id=s.attachment_id WHERE s.status='accepted' AND s.public_consent=1 ORDER BY s.updated_at DESC"),
 ]);
 return {projects,abstracts};
}
export async function readConferenceState(db:D1Database,p:Profile){
 const manager=canOrganise(p);
 const [abstracts,assignments,reviews,grants,attachments,accessGrants]=await Promise.all([
  all(db,"SELECT s.*,p.name AS owner_name,a.name AS attachment_name FROM abstracts s JOIN profiles p ON p.id=s.owner_id LEFT JOIN attachments a ON a.id=s.attachment_id WHERE ?=1 OR s.owner_id=? OR s.status='accepted' OR EXISTS(SELECT 1 FROM assignments x WHERE x.user_id=? AND x.submission_type='abstract' AND x.submission_id=s.id AND x.submission_version=s.version AND x.status!='declined') ORDER BY s.updated_at DESC",manager?1:0,p.id,p.id),
  all(db,"SELECT x.*,p.name AS assignee_name,CASE WHEN x.submission_type='project' THEN j.title ELSE s.title END AS submission_title,CASE WHEN x.submission_type='project' THEN j.version ELSE s.version END AS current_version FROM assignments x JOIN profiles p ON p.id=x.user_id LEFT JOIN projects j ON x.submission_type='project' AND j.id=x.submission_id LEFT JOIN abstracts s ON x.submission_type='abstract' AND s.id=x.submission_id WHERE ?=1 OR x.user_id=? ORDER BY x.created_at DESC",manager?1:0,p.id),
  all(db,"SELECT r.*,p.name AS reviewer_name,s.owner_id,s.status AS abstract_status FROM abstract_reviews r JOIN profiles p ON p.id=r.reviewer_id JOIN abstracts s ON s.id=r.abstract_id WHERE ?=1 OR r.reviewer_id=? OR (s.owner_id=? AND r.author_released=1 AND r.status='submitted') ORDER BY r.updated_at DESC",manager?1:0,p.id,p.id),
  manager?all(db,'SELECT user_id,role FROM role_grants'):Promise.resolve([]),
  all(db,'SELECT id,name,size,created_at FROM attachments WHERE owner_id=? ORDER BY created_at DESC',p.id),
  manager?all(db,'SELECT email,role FROM role_allowlist ORDER BY email'):Promise.resolve([]),
 ]);
 return {abstracts,assignments,abstractReviews:reviews.map(r=>manager||r.reviewer_id===p.id?r:{id:r.id,abstract_id:r.abstract_id,submission_version:r.submission_version,status:r.status,author_feedback:r.author_feedback,recommendation:r.recommendation,reviewer_name:'Reviewer',updated_at:r.updated_at}),roleGrants:grants,attachments,accessGrants};
}
async function submission(db:D1Database,type:string,submissionId:string){return required(db,type==='project'?'projects':'abstracts',submissionId);}
async function currentAssignment(db:D1Database,p:Profile,type:string,item:any){
 const assignment=await one(db,"SELECT * FROM assignments WHERE user_id=? AND submission_type=? AND submission_id=? AND submission_version=? AND status!='declined'",p.id,type,item.id,item.version);
 if(!assignment)throw new AppError('This version has not been assigned to your account.',403);
 return assignment;
}
async function checkConflict(db:D1Database,profile:Profile,item:any){
 const author=await required(db,'profiles',item.owner_id);
 if(item.owner_id===profile.id||String(author.email).trim().toLowerCase()===String(profile.email).trim().toLowerCase())throw new AppError('You cannot review or judge your own submission.',403);
}
async function open(db:D1Database,key:string,message:string){const setting=await one(db,'SELECT value FROM settings WHERE key=?',key);if(setting?.value!=='true')throw new AppError(message);}

export async function actConference(db:D1Database,p:Profile,d:Data):Promise<Record<string,unknown>|undefined>{
 const action=d.action;
 if(action==='abstract'){
  const intent=pick(d,'intent',['draft','submit']),isSubmit=intent==='submit';
  const person=await required(db,'profiles',p.id);if(!person.registered_at)throw new AppError('Complete event registration before submitting an abstract.');
  if(isSubmit)await open(db,'abstracts_open','Abstract submissions are currently closed.');
  const title=text(d,'title',3,200),authors=text(d,'authors',isSubmit?2:0,500),affiliations=text(d,'affiliations',isSubmit?2:0,500),category=pick(d,'category',categories),keywords=text(d,'keywords',isSubmit?2:0,300),body=text(d,'body',isSubmit?100:0,5000),presentation=pick(d,'presentation',['Oral presentation','Poster','Online presentation']);
  if(body.split(/\s+/).filter(Boolean).length>500)throw new AppError('Keep the abstract to 500 words or fewer.');
  const projectId=typeof d.project_id==='string'&&d.project_id?d.project_id:null;
  if(projectId){const linked=await required(db,'projects',projectId);if(linked.owner_id!==p.id)throw new AppError('Link only a project submitted by your account.',403);}
  const attachmentId=await checkAttachmentOwnership(db,typeof d.attachment_id==='string'?d.attachment_id:null,p.id);
  const consent=d.public_consent===true?1:0,abstractId=typeof d.id==='string'?d.id:'';
  if(abstractId){
   const item=await required(db,'abstracts',abstractId);if(item.owner_id!==p.id)throw new AppError('You can edit only your own abstract.',403);
   if(!['draft','revision_requested'].includes(item.status))throw new AppError('This abstract is locked for review. Ask an organiser to request a revision.');
   const version=item.status==='revision_requested'?item.version+1:item.version;
   await stmt(db,"UPDATE abstracts SET title=?,authors=?,affiliations=?,category=?,keywords=?,body=?,presentation=?,project_id=?,attachment_id=?,public_consent=?,status=?,version=?,decision_note=CASE WHEN ?='submitted' THEN '' ELSE decision_note END,updated_at=? WHERE id=?",title,authors,affiliations,category,keywords,body,presentation,projectId,attachmentId,consent,isSubmit?'submitted':'draft',version,isSubmit?'submitted':'draft',now(),abstractId).run();
  }else await stmt(db,'INSERT INTO abstracts (id,owner_id,title,authors,affiliations,category,keywords,body,presentation,project_id,attachment_id,public_consent,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id(),p.id,title,authors,affiliations,category,keywords,body,presentation,projectId,attachmentId,consent,isSubmit?'submitted':'draft',now(),now()).run();
 }else if(action==='abstract_decision'){
  organiser(p);const item=await required(db,'abstracts',text(d,'id',1,100));if(['draft','withdrawn'].includes(item.status))throw new AppError('Only submitted abstracts can receive a decision.');
  const status=pick(d,'status',['under_review','revision_requested','accepted','rejected']),note=text(d,'decision_note',status==='revision_requested'||status==='rejected'?5:0,2000);
  await stmt(db,"UPDATE abstracts SET status=?,decision_note=?,award=CASE WHEN ?='accepted' THEN award ELSE '' END,updated_at=? WHERE id=?",status,note,status,now(),item.id).run();
  if(['accepted','revision_requested','rejected'].includes(status))await stmt(db,"UPDATE abstract_reviews SET author_released=1 WHERE abstract_id=? AND submission_version=? AND status='submitted'",item.id,item.version).run();
 }else if(action==='abstract_award'){
  organiser(p);const item=await required(db,'abstracts',text(d,'id',1,100));if(item.status!=='accepted')throw new AppError('Accept the abstract before announcing an award.');await stmt(db,'UPDATE abstracts SET award=?,updated_at=? WHERE id=?',text(d,'award',0,120),now(),item.id).run();
 }else if(action==='withdraw_submission'){
  const type=pick(d,'submission_type',['project','abstract']),item=await submission(db,type,text(d,'id',1,100));
  if(item.owner_id!==p.id&&!canOrganise(p))throw new AppError('Only the author or organising team can withdraw this submission.',403);
  await stmt(db,"UPDATE "+(type==='project'?'projects':'abstracts')+" SET status='withdrawn',award='' WHERE id=?",item.id).run();
 }else if(action==='assign'){
  organiser(p);const type=pick(d,'submission_type',['project','abstract']),item=await submission(db,type,text(d,'submission_id',1,100)),person=await profileWithRoles(db,text(d,'user_id',1,100));
  if(!hasRole(person,type==='project'?'judge':'reviewer'))throw new AppError('Assign a '+(type==='project'?'judge':'reviewer')+' role to this account first.');
  await checkConflict(db,person,item);
  if(type==='project'&&item.status!=='approved')throw new AppError('Approve the project before assigning judges.');
  if(type==='abstract'&&!['submitted','under_review'].includes(item.status))throw new AppError('Only an active submitted abstract can be assigned.');
  await stmt(db,"INSERT INTO assignments (id,user_id,submission_type,submission_id,submission_version,status,created_at) VALUES (?,?,?,?,?,'assigned',?) ON CONFLICT(user_id,submission_type,submission_id,submission_version) DO UPDATE SET status='assigned',decline_reason=''",id(),person.id,type,item.id,item.version,now()).run();
  if(type==='abstract'&&item.status==='submitted')await stmt(db,"UPDATE abstracts SET status='under_review' WHERE id=?",item.id).run();
 }else if(action==='remove_assignment'){
  organiser(p);const assignment=await required(db,'assignments',text(d,'id',1,100));
  await stmt(db,"UPDATE assignments SET status='declined',decline_reason='Removed by organising team' WHERE id=?",assignment.id).run();
 }else if(action==='decline_assignment'){
  const assignment=await required(db,'assignments',text(d,'id',1,100));if(assignment.user_id!==p.id)throw new AppError('This assignment belongs to another account.',403);
  if(assignment.status==='completed')throw new AppError('Contact an organiser to change a completed assignment.');
  await stmt(db,"UPDATE assignments SET status='declined',decline_reason=? WHERE id=?",text(d,'decline_reason',5,1000),assignment.id).run();
 }else if(action==='review_abstract'){
  if(!hasRole(p,'reviewer'))throw new AppError('Reviewer access is required.',403);
  await open(db,'reviewing_open','Abstract reviewing is currently closed.');
  const item=await required(db,'abstracts',text(d,'abstract_id',1,100));
  if(!['submitted','under_review'].includes(item.status))throw new AppError('This abstract is not open for review.');
  await checkConflict(db,p,item);const assignment=await currentAssignment(db,p,'abstract',item);
  if(d.no_conflict!==true)throw new AppError('Confirm that you have no conflict of interest before reviewing.');
  const values=abstractRubric.map(([key])=>{const value=d[key];if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>5)throw new AppError('Score each criterion from 1 to 5.');return value;});
  const status=pick(d,'status',['draft','submitted']),recommendation=pick(d,'recommendation',['accept','revise','reject']),feedback=text(d,'author_feedback',status==='submitted'?10:0,3000),notes=text(d,'confidential_notes',0,3000);
  await db.batch([
   stmt(db,'INSERT INTO abstract_reviews (id,reviewer_id,abstract_id,submission_version,relevance,originality,clarity,rigour,impact,recommendation,author_feedback,confidential_notes,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(reviewer_id,abstract_id,submission_version) DO UPDATE SET relevance=excluded.relevance,originality=excluded.originality,clarity=excluded.clarity,rigour=excluded.rigour,impact=excluded.impact,recommendation=excluded.recommendation,author_feedback=excluded.author_feedback,confidential_notes=excluded.confidential_notes,status=excluded.status,updated_at=excluded.updated_at',id(),p.id,item.id,item.version,...values,recommendation,feedback,notes,status,now()),
   stmt(db,'UPDATE assignments SET status=? WHERE id=?',status==='submitted'?'completed':'in_progress',assignment.id),
  ]);
 }else if(action==='permissions'){
  administrator(p);const userId=text(d,'id',1,100);await required(db,'profiles',userId);
  if(!Array.isArray(d.roles)||d.roles.some(role=>typeof role!=='string'||!privilegedRoles.includes(role as any)))throw new AppError('Choose valid account permissions.');
  const roles=[...new Set(d.roles as string[])];const owner=await one(db,"SELECT value FROM settings WHERE key='workspace_owner'");if(userId===owner?.value&&!roles.includes('administrator'))throw new AppError('The workspace owner must remain an administrator.');
  const target=await required(db,'profiles',userId);
  await db.batch([stmt(db,"UPDATE profiles SET role=? WHERE id=?",userId===owner?.value?'administrator':'attendee',userId),stmt(db,'DELETE FROM role_allowlist WHERE email=?',String(target.email).trim().toLowerCase()),stmt(db,'DELETE FROM role_grants WHERE user_id=?',userId),...roles.map(role=>stmt(db,'INSERT INTO role_grants (id,user_id,role) VALUES (?,?,?)',id(),userId,role))]);
 }else if(action==='permissions_by_email'){
  administrator(p);const email=text(d,'email',5,250).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new AppError('Enter a valid email address.');
  if(!Array.isArray(d.roles)||d.roles.some(role=>typeof role!=='string'||!privilegedRoles.includes(role as any)))throw new AppError('Choose valid account permissions.');
  const roles=[...new Set(d.roles as string[])],owner=await one(db,"SELECT p.email FROM profiles p JOIN settings s ON s.key='workspace_owner' AND s.value=p.id");
  if(String(owner?.email).trim().toLowerCase()===email&&!roles.includes('administrator'))throw new AppError('The workspace owner must remain an administrator.');
  await db.batch([stmt(db,'DELETE FROM role_allowlist WHERE email=?',email),stmt(db,"UPDATE profiles SET role='attendee' WHERE LOWER(TRIM(email))=? AND id!=(SELECT value FROM settings WHERE key='workspace_owner')",email),stmt(db,'DELETE FROM role_grants WHERE user_id IN (SELECT id FROM profiles WHERE LOWER(TRIM(email))=?)',email),...roles.map(role=>stmt(db,'INSERT INTO role_allowlist (id,email,role) VALUES (?,?,?)',id(),email,role))]);
 }else if(action==='conference_export'){
  organiser(p);const dataset=pick(d,'dataset',['abstracts','abstract_reviews','assignments']);
  const sql:Record<string,string>={abstracts:'SELECT title,authors,affiliations,category,keywords,body,presentation,status,version,decision_note,award,public_consent FROM abstracts',abstract_reviews:'SELECT a.title,r.submission_version,p.name AS reviewer,r.relevance,r.originality,r.clarity,r.rigour,r.impact,r.recommendation,r.author_feedback,r.confidential_notes,r.status FROM abstract_reviews r JOIN abstracts a ON a.id=r.abstract_id JOIN profiles p ON p.id=r.reviewer_id',assignments:'SELECT p.name AS assignee,x.submission_type,x.submission_id,x.submission_version,x.status,x.decline_reason FROM assignments x JOIN profiles p ON p.id=x.user_id'};
  return {rows:await all(db,sql[dataset])};
 }else return undefined;
 return {ok:true};
}
export {currentAssignment,checkConflict};
