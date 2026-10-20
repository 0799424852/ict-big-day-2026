import type {Profile} from './types.ts';
import {canOrganise,canAdminister} from './permissions.ts';
export type Data=Record<string,unknown>;
export type Row=Record<string,any>;
export class AppError extends Error{status:number;constructor(message:string,status=400){super(message);this.status=status;}}
export const id=()=>crypto.randomUUID();
export const now=()=>new Date().toISOString();
export const stmt=(db:D1Database,sql:string,...args:any[])=>db.prepare(sql).bind(...args);
export const all=async(db:D1Database,sql:string,...args:any[])=>(await stmt(db,sql,...args).all<Row>()).results;
export const one=async(db:D1Database,sql:string,...args:any[])=>stmt(db,sql,...args).first<Row>();
export function text(d:Data,k:string,min=0,max=500){const v=d[k];if(typeof v!=='string'||v.trim().length<min||v.trim().length>max)throw new AppError(k.replaceAll('_',' ')+' must contain '+min+'–'+max+' characters.');return v.trim();}
export function pick(d:Data,k:string,choices:readonly string[]){const v=text(d,k,1,80);if(!choices.includes(v))throw new AppError('Choose a valid '+k.replaceAll('_',' ')+'.');return v;}
export function url(v:string){if(!v)return '';try{const u=new URL(v);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw new Error();return u.toString();}catch{throw new AppError('Use a complete http or https link.');}}
export function date(v:string){if(!v)return '';const parsed=new Date(v+'T12:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==v)throw new AppError('Use a valid date.');return v;}
export function organiser(p:Profile){if(!canOrganise(p))throw new AppError('Only organisers or administrators can perform this action.',403);}
export function administrator(p:Profile){if(!canAdminister(p))throw new AppError('Only administrators can manage account permissions.',403);}
export async function required(db:D1Database,table:string,itemId:string){if(!['projects','opportunities','connections','questions','sessions','profiles','abstracts','assignments','attachments'].includes(table))throw new AppError('Invalid record.');const item=await one(db,'SELECT * FROM '+table+' WHERE id=?',itemId);if(!item)throw new AppError('This record could not be found.',404);return item;}
export async function profileWithRoles(db:D1Database,userId:string){const p=await required(db,'profiles',userId);const grants=await all(db,'SELECT role FROM role_grants WHERE user_id=? UNION SELECT role FROM role_allowlist WHERE email=? AND EXISTS (SELECT 1 FROM auth_users WHERE id=? AND email_verified=1)',userId,String(p.email).trim().toLowerCase(),userId);return {...p,roles:[...new Set([p.role,...grants.map(x=>x.role)])]} as Profile;}
export async function checkAttachmentOwnership(db:D1Database,fileId:string|null|undefined,ownerId:string){if(!fileId)return null;const attachment=await required(db,'attachments',fileId);if(attachment.owner_id!==ownerId)throw new AppError('Use an attachment uploaded by your account.',403);return fileId;}
