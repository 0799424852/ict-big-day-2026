import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,cpSync,writeFileSync,existsSync} from 'node:fs';
import {DatabaseSync,backup} from 'node:sqlite';
import {authStore} from './auth.mjs';
const root=dirname(fileURLToPath(import.meta.url)),data=join(root,'data');
if(!existsSync(join(data,'event.sqlite')))throw new Error('Start the website and create an administrator first.');
const sql=new DatabaseSync(join(data,'event.sqlite'));sql.exec('PRAGMA busy_timeout=5000');
if(process.argv.includes('--recover')){
 const auth=authStore(sql),owner=auth.ownerId();if(!owner)throw new Error('Create an administrator first.');
 const value=auth.reset(owner);console.log('\nAdministrator recovery link (expires in 30 minutes; works once):\nhttp://127.0.0.1:3000/auth/reset?token='+value+'\nKeep it private. The website must be running.');
}else{
 const destination=join(root,'backups',new Date().toISOString().replaceAll(':','-').replaceAll('.','-'));mkdirSync(destination,{recursive:true});
 await backup(sql,join(destination,'event.sqlite'));
 for(const name of ['uploads','hosting.json','tunnel-token.txt','instance-id.txt'])if(existsSync(join(data,name)))cpSync(join(data,name),join(destination,name),{recursive:true});
 writeFileSync(join(destination,'RESTORE.txt'),'Keep this backup private. To restore, stop the website, rename the current data folder, create a new data folder and copy event.sqlite plus the other files/folders from this backup into it. Never combine old SQLite WAL/SHM files with the restored database.\n');
 console.log('\nBackup created:\n'+destination+'\nIt contains personal records and may contain the tunnel token. Store it privately.');
}
sql.close();
