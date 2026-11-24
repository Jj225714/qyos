import { readFile, writeFile, rename, mkdir, unlink, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const args=Object.fromEntries(Array.from({length:Math.floor((process.argv.length-2)/2)},(_,i)=>process.argv.slice(i*2+2,i*2+4)));
if(!args['--file']||!['grant','revoke','list'].includes(args['--action'])||(args['--action']!=='list'&&!/^[1-9]\d{0,19}$/.test(args['--user-id']||''))) {
    console.error('Usage: node admin-users.mjs --file /private/admin-users.json --action grant|revoke|list [--user-id ACCOUNT_ID]');process.exitCode=1;
}else{
    const file=resolve(args['--file']);let ids=[];try{ids=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(ids)||ids.some(x=>!/^[1-9]\d{0,19}$/.test(String(x))))throw Error('Invalid administrator file');}catch(e){if(e.code!=='ENOENT')throw e;}
    ids=[...new Set(ids.map(String))];
    if(args['--action']==='grant'&&!ids.includes(args['--user-id']))ids.push(args['--user-id']);
    if(args['--action']==='revoke')ids=ids.filter(id=>id!==args['--user-id']);
    if(args['--action']!=='list'){
        await mkdir(dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';
        try{await writeFile(tmp,JSON.stringify(ids)+'\n',{mode:0o600,flag:'wx'});await chmod(tmp,0o640);await rename(tmp,file);}finally{await unlink(tmp).catch(()=>{});}
    }
    console.log(JSON.stringify({administratorIds:ids}));
}
