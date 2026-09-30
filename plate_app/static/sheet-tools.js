/* Pure clipboard helpers shared by the browser and Node tests. */
(function(root){
  function parseTSV(text){
    const rows=[], row=[];let value='',quoted=false;
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(c==='"' && (quoted || value==='')){
        if(quoted && text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;
      }else if(!quoted && (c==='\t'||c==='\n'||c==='\r')){
        row.push(value);value='';
        if(c!=='\t'){rows.push(row.splice(0));if(c==='\r'&&text[i+1]==='\n')i++;}
      }else value+=c;
    }
    if(quoted)throw Error('Unclosed quotation mark. Copy the cell range from Excel again.');
    if(value!==''||row.length||!rows.length){row.push(value);rows.push(row);}
    return rows;
  }
  function planPaste(text, rowIndex, colIndex, locations, fields, skipBlank){
    const rows=parseTSV(text);
    if(rowIndex+rows.length>locations.length || rows.some(r=>colIndex+r.length>fields.length))
      throw Error('The paste range extends beyond the table. Check the starting cell, visible columns and row count. No changes were applied.');
    const changes=[];
    rows.forEach((row,r)=>row.forEach((value,c)=>{
      if(value.length>5000)throw Error('Use no more than 5,000 characters per cell. No changes were applied.');
      if(!skipBlank||value!=='')changes.push({loc:locations[rowIndex+r],key:fields[colIndex+c],value});
    }));
    return changes;
  }
  function rectangle(anchor,end){return {r0:Math.min(anchor.r,end.r),r1:Math.max(anchor.r,end.r),c0:Math.min(anchor.c,end.c),c1:Math.max(anchor.c,end.c)};}
  function serializeTSV(rows){return rows.map(row=>row.map(value=>{const s=String(value??'');return /[\t\r\n"]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;}).join('\t')).join('\r\n');}
  function normalizeGene(value){const text=value.trim(),m=text.match(/^([A-Za-z0-9][A-Za-z0-9.\-]*?)[_\-\s]+[Ii][Nn]\s*0*([1-9][0-9]*)$/);return m?`${m[1]}_In${m[2]}`:text;}
  function normalizeStock(value){const text=value.trim(),m=text.match(/^([A-Za-z0-9][A-Za-z0-9.\-]*?)[_\-\s]+(In0*([1-9][0-9]*)|3UTR)[_\-\s]+(Bulk|CLONE0*([1-9][0-9]*))$/i);return m?`${m[1]}_${m[3]?'In'+m[3]:'3UTR'}_${m[5]?'CLONE'+m[5]:'Bulk'}`:text;}
  function matchesWell(row,query,exact=false){
    const q=normalizeGene(query).toLowerCase();if(!q)return true;
    const gene=normalizeGene(row.well.Gene_intron||'').toLowerCase(),stock=normalizeStock(row.well.Cell_Line_Stock||'').toLowerCase();
    if(exact){const locus=stock.match(/^(.+)_(in[1-9][0-9]*|3utr)_(bulk|clone[1-9][0-9]*)$/);return [gene,gene.replace(/_(in[1-9][0-9]*|3utr)$/,''),...(locus?[locus[1],locus[1]+'_'+locus[2]]:[])].includes(q);}
    return [row.plate,row.loc,...Object.values(row.metadata),...Object.values(row.well),gene,stock].some(v=>String(v).toLowerCase().includes(q));
  }
  const api={parseTSV,planPaste,rectangle,serializeTSV,normalizeGene,normalizeStock,matchesWell};
  if(typeof module!=='undefined')module.exports=api;else root.SheetTools=api;
})(typeof window!=='undefined'?window:globalThis);
