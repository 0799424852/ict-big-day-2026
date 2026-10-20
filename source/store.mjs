import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

export function openStore(directory,migrations){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const sql=new DatabaseSync(join(directory,'event.sqlite'));
 sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 sql.exec('CREATE TABLE IF NOT EXISTS host_migrations (name TEXT PRIMARY KEY)');
 for(const file of readdirSync(migrations).filter(x=>x.endsWith('.sql')).sort()){
  if(sql.prepare('SELECT name FROM host_migrations WHERE name=?').get(file))continue;
  sql.exec('BEGIN IMMEDIATE');
  try{sql.exec(readFileSync(join(migrations,file),'utf8'));sql.prepare('INSERT INTO host_migrations (name) VALUES (?)').run(file);sql.exec('COMMIT');}
  catch(error){sql.exec('ROLLBACK');throw error;}
 }
 sql.exec(`CREATE TABLE IF NOT EXISTS auth_users (
 id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,
 email_verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_resets (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
 class Statement{
  constructor(query,args=[]){this.query=query;this.args=args;}
  bind(...args){return new Statement(this.query,args);}
  async first(){return sql.prepare(this.query).get(...this.args)||null;}
  async all(){return {results:sql.prepare(this.query).all(...this.args),success:true};}
  runSync(){const out=sql.prepare(this.query).run(...this.args);return {success:true,meta:{changes:Number(out.changes)}};}
  async run(){return this.runSync();}
 }
 const db={prepare:query=>new Statement(query),batch:async statements=>{
  sql.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.runSync());sql.exec('COMMIT');return out;}catch(error){sql.exec('ROLLBACK');throw error;}
 }};
 let tail=Promise.resolve();
 const exclusive=operation=>{const next=tail.then(operation,operation);tail=next.catch(()=>{});return next;};
 return {sql,db,exclusive,close:()=>sql.close()};
}
