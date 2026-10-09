import PDFDocument from 'pdfkit';
export function generatePDF(title:string,body:string,options:{version?:number;status?:string;locale?:string;diagram?:Buffer}={}):Promise<Buffer>{
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margin:54,bufferPages:true,info:{Title:title,Author:'Onesa UG',Subject:options.status||'Draft — review required'}});
  const chunks:Buffer[]=[];doc.on('data',b=>chunks.push(b));doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));
  doc.rect(0,0,595.28,841.89).fill('#081B32');doc.fillColor('#53DBE8').fontSize(20).text('ONESA UG',54,72);
  doc.fillColor('white').fontSize(36).text(title,54,230,{width:480});doc.fontSize(12).text(`Version ${options.version||1}\nIssued ${new Date().toISOString().slice(0,10)}\n${options.status||'DRAFT — subject to verification and approval'}`,54,560);
  doc.addPage();doc.y=90;
  if(options.diagram){doc.image(options.diagram,54,90,{fit:[487,300]});doc.y=410;}
  const lines=body.split('\n');
  for(let n=0;n<lines.length;n++){
   if(lines[n].trim().startsWith('|')){
    const rows:string[][]=[];while(n<lines.length&&lines[n].trim().startsWith('|')){const cells=lines[n].trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());if(!cells.every(c=>/^[-: ]+$/.test(c)))rows.push(cells);n++;}n--;
    const count=Math.max(...rows.map(r=>r.length)),width=487/count;
    rows.forEach((row,index)=>{doc.font('Helvetica').fontSize(9);const height=Math.max(...row.map(cell=>doc.heightOfString(cell,{width:width-16})))+18;if(doc.y+height>735){doc.addPage();doc.y=90;}const y=doc.y;for(let c=0;c<count;c++){doc.rect(54+c*width,y,width,height).fillAndStroke(index===0?'#EAF4FA':'#FFFFFF','#DAE1E9');doc.fillColor('#081B32').font(index===0?'Helvetica-Bold':'Helvetica').text(row[c]||'',62+c*width,y+8,{width:width-16});}doc.y=y+height;});doc.moveDown();
   }else{
    if(doc.y>735){doc.addPage();doc.y=90;}
    const heading=/^#{1,3} /.test(lines[n]);doc.fillColor('#081B32').font(heading?'Helvetica-Bold':'Helvetica').fontSize(heading?15:11).text(lines[n].replace(/^#{1,3} /,''),54,doc.y,{width:487,lineGap:5});
   }
  }
  const range=doc.bufferedPageRange();
  for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);if(i>0)doc.fillColor('#64748B').font('Helvetica').fontSize(9).text('ONESA UG · '+title,54,35,{width:480});doc.fillColor(i===0?'#53DBE8':'#64748B').font('Helvetica').fontSize(9).text(`${options.status||'DRAFT'} · ${i+1} / ${range.count}`,54,770,{width:480,lineBreak:false});}
  doc.end();
 });
}
