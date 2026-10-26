# Test only (Task 20's rollback checks): the given app image plus one database update that damages data, commits that
# damage (so the migrator's own transaction cannot undo it), then fails. Only the restore of the pre-update backup can undo it.
ARG BASE
FROM ${BASE}
USER root
RUN node -e "const fs=require('fs');const d='apps/server/drizzle';const f=d+'/meta/_journal.json';const j=JSON.parse(fs.readFileSync(f,'utf8'));const tag='9999_broken_for_rollback_test';j.entries.push({idx:j.entries.length,version:'7',when:Date.now(),tag,breakpoints:true});fs.writeFileSync(f,JSON.stringify(j,null,2));fs.writeFileSync(d+'/'+tag+'.sql',['UPDATE notes SET title = \'DAMAGED BY A BAD MIGRATION\';','CREATE TABLE rollback_probe (x int);','COMMIT;','SELECT 1/0;'].join('\n--> statement-breakpoint\n'))"
USER node
