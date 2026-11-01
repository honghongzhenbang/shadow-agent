import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.mjs';
const database=process.argv[2]??loadConfig().paths.database;
const db=new DatabaseSync(database,{readOnly:true});
try {
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
  const counts=Object.fromEntries(['evidence','sources','tasks','graph_entities','graph_facts','voice_recordings','voice_segments','voice_speaker_samples','context_changes']
    .map(t=>[t,tables.has(t)?db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n:null]));
  const result={at:new Date().toISOString(),database,counts,
    recordings:tables.has('voice_recordings')?db.prepare('SELECT status,COUNT(*) n,MIN(recorded_at) first,MAX(recorded_at) last FROM voice_recordings GROUP BY status').all():[],
    voiceQueue:db.prepare("SELECT c.seq,c.status,c.session_key,COUNT(m.evidence_id) evidenceCount FROM context_changes c LEFT JOIN context_change_evidence m ON m.change_seq=c.seq WHERE json_extract(c.metadata_json,'$.provider')='voice' GROUP BY c.seq").all(),
    schema:db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()};
  if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,schema:undefined}));
} finally {db.close();}
