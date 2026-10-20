import {scrypt,randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const derive=promisify(scrypt);
const cost={N:32768,r:8,p:1,maxmem:64*1024*1024};
const day=24*60*60*1000;
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const token=()=>randomBytes(32).toString('base64url');
export const normalEmail=value=>String(value||'').trim().toLowerCase();
export function checkEmail(value){const email=normalEmail(value);if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))throw Object.assign(new Error('Enter a valid email address.'),{status:400});return email;}
export function checkPassword(value){if(typeof value!=='string'||value.length<12||value.length>128)throw Object.assign(new Error('Use a password or passphrase of 12–128 characters.'),{status:400});return value;}
export async function passwordHash(password){checkPassword(password);const salt=randomBytes(16).toString('hex');const key=await derive(password,salt,32,cost);return salt+':'+key.toString('hex');}
export async function passwordMatches(password,stored){
 const [salt,key]=(stored||'00000000000000000000000000000000:'+ '0'.repeat(64)).split(':');
 const derived=await derive(String(password).slice(0,129),salt,32,cost);
 const expected=Buffer.from(key,'hex');return derived.length===expected.length&&timingSafeEqual(derived,expected);
}
export function authStore(sql){
 function ownerId(){return sql.prepare("SELECT value FROM settings WHERE key='workspace_owner'").get()?.value||null;}
 function limit(key,maximum,period=15*60*1000){
  const stamp=Date.now();sql.prepare('DELETE FROM auth_limits WHERE expires_at<?').run(stamp);
  sql.prepare('INSERT INTO auth_limits (key,attempts,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1').run(digest(key),stamp+period);
  if(sql.prepare('SELECT attempts FROM auth_limits WHERE key=?').get(digest(key)).attempts>maximum)throw Object.assign(new Error('Too many attempts. Please wait before trying again.'),{status:429});
 }
 function account(id){return sql.prepare('SELECT id,email,name,email_verified FROM auth_users WHERE id=?').get(id)||null;}
 async function create({email,name,password},owner=false){
  email=checkEmail(email);name=String(name||'').trim();if(name.length<2||name.length>100)throw Object.assign(new Error('Enter a name of 2–100 characters.'),{status:400});
  if(sql.prepare('SELECT id FROM auth_users WHERE email=?').get(email))throw Object.assign(new Error('This address cannot be registered. Try signing in or contact the organiser.'),{status:400});
  const hash=await passwordHash(password),id=randomUUID();
  sql.exec('BEGIN IMMEDIATE');
  try{
   if(owner&&ownerId())throw Object.assign(new Error('The administrator has already been created.'),{status:409});
   sql.prepare('INSERT INTO auth_users (id,email,name,password_hash,email_verified,created_at) VALUES (?,?,?,?,?,?)').run(id,email,name,hash,owner?1:0,new Date().toISOString());
   if(owner)sql.prepare("INSERT INTO settings (key,value) VALUES ('workspace_owner',?)").run(id);
   sql.exec('COMMIT');
  }catch(error){sql.exec('ROLLBACK');throw error;}
  return account(id);
 }
 function session(userId){
  const value=token();sql.prepare('DELETE FROM auth_sessions WHERE expires_at<?').run(Date.now());
  sql.prepare('INSERT INTO auth_sessions (hash,user_id,expires_at) VALUES (?,?,?)').run(digest(value),userId,Date.now()+day);return value;
 }
 function authenticate(value){
  if(!value||value.length>100)return null;
  return sql.prepare('SELECT u.id,u.email,u.name,u.email_verified FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?').get(digest(value),Date.now())||null;
 }
 async function login(email,password){const user=sql.prepare('SELECT * FROM auth_users WHERE email=?').get(normalEmail(email));const good=await passwordMatches(password,user?.password_hash);if(!user||!good)throw Object.assign(new Error('The email or password is incorrect.'),{status:401});return account(user.id);}
 function logout(value){if(value)sql.prepare('DELETE FROM auth_sessions WHERE hash=?').run(digest(value));}
 function reset(userId){
  if(!account(userId))throw Object.assign(new Error('Account not found.'),{status:404});
  const value=token();sql.prepare('DELETE FROM auth_resets WHERE user_id=? OR expires_at<?').run(userId,Date.now());
  sql.prepare('INSERT INTO auth_resets (hash,user_id,expires_at) VALUES (?,?,?)').run(digest(value),userId,Date.now()+30*60*1000);return value;
 }
 function resetValid(value){return sql.prepare('SELECT * FROM auth_resets WHERE hash=? AND expires_at>?').get(digest(String(value)),Date.now());}
 async function changePassword(value,password){
  const row=resetValid(value);if(!row)throw Object.assign(new Error('This password reset link has expired or was already used.'),{status:400});
  const hash=await passwordHash(password);
  sql.exec('BEGIN IMMEDIATE');try{
   if(!resetValid(value))throw Object.assign(new Error('This password reset link was already used.'),{status:400});
   sql.prepare('UPDATE auth_users SET password_hash=? WHERE id=?').run(hash,row.user_id);
   sql.prepare('DELETE FROM auth_resets WHERE user_id=?').run(row.user_id);sql.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(row.user_id);sql.exec('COMMIT');
  }catch(error){sql.exec('ROLLBACK');throw error;}
 }
 return {ownerId,limit,account,create,session,authenticate,login,logout,reset,resetValid,changePassword};
}
