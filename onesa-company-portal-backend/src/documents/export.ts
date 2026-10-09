import { mkdir,writeFile } from 'node:fs/promises';
import { templates } from './templates.js';
import { generatePDF } from './pdf.js';
const dir=process.env.EXPORT_DIR||'../assets/documents';await mkdir(dir,{recursive:true});for(const [key,t] of Object.entries(templates)){const bytes=await generatePDF(t.title,t.body,{locale:t.locale});await writeFile(`${dir}/${key}.pdf`,bytes);}console.log(`Exported ${Object.keys(templates).length} draft PDFs to ${dir}`);
