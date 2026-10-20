import type {Profile} from './types.ts';
import {canOrganise} from './permissions.ts';
import {one} from './core.ts';
export async function mayReadAttachment(db:D1Database,fileId:string,profile:Profile|null){
 const file=await one(db,'SELECT * FROM attachments WHERE id=?',fileId);if(!file)return null;
 if(profile&&(file.owner_id===profile.id||canOrganise(profile)))return file;
 const published=await one(db,"SELECT id FROM projects WHERE attachment_id=? AND status='approved' AND (?=1 OR public_consent=1) UNION SELECT id FROM abstracts WHERE attachment_id=? AND status='accepted' AND (?=1 OR public_consent=1) LIMIT 1",fileId,profile?1:0,fileId,profile?1:0);
 if(published)return file;
 if(profile){
  const assigned=await one(db,"SELECT x.id FROM assignments x LEFT JOIN projects j ON x.submission_type='project' AND j.id=x.submission_id LEFT JOIN abstracts a ON x.submission_type='abstract' AND a.id=x.submission_id WHERE x.user_id=? AND x.status!='declined' AND ((j.attachment_id=? AND j.version=x.submission_version) OR (a.attachment_id=? AND a.version=x.submission_version)) LIMIT 1",profile.id,fileId,fileId);
  if(assigned)return file;
 }
 return null;
}
