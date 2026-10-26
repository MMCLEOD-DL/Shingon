# Test only (Task 20's rollback checks): a broken build that also deletes every uploaded file before it exits, so the
# rollback has to put the uploads back as well as the database.
ARG BASE
FROM ${BASE}
CMD ["node", "-e", "const fs=require('fs');for(const e of fs.readdirSync('/data/uploads'))fs.rmSync('/data/uploads/'+e,{recursive:true,force:true});console.error('deliberately broken build: the uploads were wiped');process.exit(1)"]
