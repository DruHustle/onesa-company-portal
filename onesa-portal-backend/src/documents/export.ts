import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {templates} from './templates.js';
import {generatePDF} from './pdf.js';
const dir=process.env.EXPORT_DIR||'../assets/documents';
await mkdir(dir,{recursive:true,mode:0o700});
const manifest=[];
for(const [key,t] of Object.entries(templates)){
 const bytes=await generatePDF(t.title,t.body,{locale:t.locale});
 const filename=`${key}.pdf`;
 await writeFile(`${dir}/${filename}`,bytes,{mode:0o600});
 manifest.push({key,title:t.title,filename,locale:t.locale,version:1,status:'draft',classification:'internal',publicationApproval:'pending',generatedAt:new Date().toISOString(),sha256:createHash('sha256').update(bytes).digest('hex'),sourceSha256:createHash('sha256').update(t.body).digest('hex'),bytes:bytes.length,limitation:'Template export; not an official register extract, executed contract, filed account or approved corporate record'});
}
await writeFile(`${dir}/manifest.json`,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
console.log(`Exported ${manifest.length} draft PDFs and classification manifest to ${dir}`);
