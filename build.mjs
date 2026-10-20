import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
const root=dirname(fileURLToPath(import.meta.url));
const ownRequire=createRequire(join(root,'package.json'));
let require=ownRequire,build,nodeModules=join(root,'node_modules');
try{({build}=require('esbuild'));}catch{
 // The authoring checkout supplies pinned dependencies when preparing this export.
 const authoring=resolve(root,'../ict-big-day');require=createRequire(join(authoring,'package.json'));
 try{({build}=require('./node_modules/.pnpm/esbuild@0.28.0/node_modules/esbuild'));nodeModules=join(authoring,'node_modules');}
 catch{throw new Error('To rebuild the editable source, run npm install in this folder, then npm run build. Running the prebuilt website needs no npm install.');}
}
const shared={bundle:true,logLevel:'warning',nodePaths:[nodeModules],legalComments:'linked'};
await build({...shared,entryPoints:[join(root,'source/client.tsx')],platform:'browser',format:'esm',target:'es2022',jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'},outfile:join(root,'public/assets/app.js')});
for(const [input,output] of [['source/start.mjs','start.mjs'],['source/maintenance.mjs','maintenance.mjs'],['source/server.mjs','event-app.mjs']])await build({...shared,entryPoints:[join(root,input)],platform:'node',format:'esm',target:'node24',outfile:join(root,output)});
// The app uses custom class names. Keep the vendored reset and editable styles together.
writeFileSync(join(root,'public/assets/app.css'),readFileSync(join(root,'source/base.css'),'utf8')+'\n'+readFileSync(join(root,'source/app/globals.css'),'utf8').replace('@import "tailwindcss";',''));
const notices=[];
for(const name of ['react','react-dom','scheduler','lucide-react']){
 try{const packageDir=dirname(require.resolve(name+'/package.json'));const license=readdirSync(packageDir).find(file=>/^licen[sc]e/i.test(file));if(license)notices.push(name+'\n'+readFileSync(join(packageDir,license),'utf8'));}catch{}
}
notices.push('QR Code generator library · Project Nayuki\n'+readFileSync(join(root,'vendor/qrcodegen.ts'),'utf8').split('*/')[0]+'*/');
notices.push('Tailwind CSS base styles\n'+readFileSync(join(root,'vendor/TAILWIND-LICENSE.txt'),'utf8'));
writeFileSync(join(root,'THIRD-PARTY-NOTICES.txt'),notices.join('\n\n----------------------------------------\n\n'));
mkdirSync(join(root,'tools'),{recursive:true});
writeFileSync(join(root,'tools','INSTALL-CLOUDFLARED.txt'),'Download cloudflared for Windows from https://developers.cloudflare.com/tunnel/downloads/ and save the 64-bit executable here as cloudflared.exe, or install the Windows MSI and reopen the launcher.\n');
console.log('Built standalone Windows application. Runtime: Node.js 24+, no npm install required.');
