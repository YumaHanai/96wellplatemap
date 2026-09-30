'use strict';
const $ = id => document.getElementById(id);
const fields = ['ID','Cell_Line_Stock','Gene_intron','Cell_type','Conditions','Primary Antibody1','Secondary Antibody1','Primary Antibody2','Secondary Antibody2','Hoechst33342','Setting','Note'];
const labels = ['Sample ID','Cell line stock','Gene / intron','Cell type','Stress / treatment conditions','Primary antibody 1','Secondary antibody 1','Primary antibody 2','Secondary antibody 2','Hoechst33342(＋ / −)','Imaging settings','Well notes'];
const meta = ['experimenter','fixation','storage','elab_experiment_id'];
const locations = Array.from({length:12},(_,c)=>[...'ABCDEFGH'].map(r=>r+(c+1))).flat();
let current = null, selected = new Set(), dirty = false, library = [], imported = null, formTouched = new Set();
let sheetUndo=[], editMode='sheet';
let anchor=null,rangeEnd=null,dragging=false,editingCell=null,geneTimer=null,geneSequence=0,geneReport={issues:[],corrections:[]};
let approvalItem=null,purgeItem=null;
function normalizedLabel(key,value){return key==='Gene_intron'?SheetTools.normalizeGene(value):key==='Cell_Line_Stock'?SheetTools.normalizeStock(value):value;}
function invalidateApprovals(loc){current.label_approvals=(current.label_approvals||[]).filter(a=>a.loc!==loc);}
const shortLabels=['ID','Cell stock','Gene intron','Cell type','Conditions','Primary Ab 1','Secondary Ab 1','Primary Ab 2','Secondary Ab 2','Hoechst','Setting','Note'];
const sheetGroups={all:fields,cells:fields.slice(0,5),staining:fields.slice(5,10),imaging:fields.slice(10)};
const meaningful = v => v !== '' && v !== '-' && v != null;
const used = w => Object.values(w).some(meaningful);
function notice(message, error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error);$('notice').hidden=false;}
async function api(url, options={}){
  const headers={'X-CSRF-Token':document.querySelector('meta[name="csrf-token"]').content,...options.headers};
  const response = await fetch(url,{...options,headers});
  const data = await response.json();
  if(!response.ok) throw Error(data.error || 'The operation failed.');
  return data;
}
function safe(fn){return async (...args)=>{try{await fn(...args);}catch(e){notice(e.message,true);}};}
function element(tag, text, cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
// Translate only known system messages saved by older releases; keep user values intact.
function englishImportWarning(message){
  const missing=message.match(/^一覧は(\d+)ウェルです。未記載位置は空欄で補完しています。$/);
  if(missing)return `The table contains ${missing[1]} wells. Missing locations have been filled with blank values.`;
  const mismatch=message.match(/^([A-H](?:[1-9]|1[0-2])): 一覧ID「(.*)」とマップ「(.*)」が異なります。$/s);
  if(mismatch)return `${mismatch[1]}: Table ID [${mismatch[2]==='空欄'?'empty':mismatch[2]}] and map label [${mismatch[3]==='空欄'?'empty':mismatch[3]}] differ.`;
  return message;
}
function canLeave(){return (!dirty && !formTouched.size) || confirm('You have unsaved changes. Discard them and leave this view?');}
function markDirty(){dirty=true;$('save-state').textContent='Unsaved changes';updateLinks();}
function updateLinks(){for(const id of ['download-table','download-map']){$(id).hidden=!current?.id || dirty || !!formTouched.size;}}
async function refreshLibrary(){library=await api('/api/plates');renderLibrary();}
function renderLibrary(){
  $('stat-plates').textContent=library.length;$('stat-wells').textContent=library.reduce((n,p)=>n+p.used,0);
  const genes=[...new Set(library.flatMap(p=>p.summary?.genes||[]))].sort();
  const stocks=[...new Set(library.flatMap(p=>(p.summary?.ki_stocks||[]).map(s=>JSON.stringify(s))))].map(s=>JSON.parse(s));
  const conditions=[...new Set(library.flatMap(p=>p.summary?.conditions||[]))].sort();
  $('stat-genes').textContent=genes.length;$('stat-stocks').textContent=stocks.length;$('stat-conditions').textContent=conditions.length;
  $('library-summary').replaceChildren(...[['Genes',genes],['KI cell stocks',stocks.map(s=>s.join(' / '))],['Conditions',conditions]].map(([label,values])=>{const section=element('div');section.append(element('b',label));const list=element('p');values.forEach(v=>list.append(element('span',v,'data-chip')));if(!values.length)list.textContent='None registered';section.append(list);return section;}));
  const q=$('search').value.toLocaleLowerCase();const matches=library.filter(p=>[p.plate,p.metadata.experimenter,p.metadata.elab_experiment_id,...(p.summary?.genes||[]),...(p.summary?.ki_stocks||[]).flat(),...(p.summary?.conditions||[])].join(' ').toLocaleLowerCase().includes(q));
  $('plate-list').replaceChildren();$('empty').hidden=library.length>0;
  if(library.length && !matches.length)$('plate-list').append(element('p','No matching plates.','muted'));
  for(const p of matches){const card=element('button',undefined,'plate-card');card.append(element('small','96 WELL PLATE','eyebrow'),element('h2',p.plate),element('p',p.metadata.experimenter||'No experimenter'),element('p',p.metadata.elab_experiment_id?'eLabFTW #'+p.metadata.elab_experiment_id:'No eLabFTW ID'),element('p',`${p.summary?.genes.length||0} genes / ${p.summary?.ki_stocks.length||0} KI cell stocks`));const cond=element('p',(p.summary?.conditions||[]).join(' / ')||'No conditions','card-conditions');card.append(cond);const foot=element('div',undefined,'card-foot');foot.append(element('span',p.used+' / 96 wells'),element('span','Open ↗'));card.append(foot);card.onclick=safe(async()=>{if(canLeave())openEditor(await api('/api/plates/'+p.id));});$('plate-list').append(card);}
}
function openEditor(p){
  $('all-wells').hidden=true;$('shared-approvals').hidden=true;
  anchor=null;rangeEnd=null;editingCell=null;geneReport=p.gene_checks||{issues:[],corrections:[]};
  sheetUndo=[];$('sheet-group').value='all';$('sheet-status').textContent='All 96 wells are displayed.';
  current=structuredClone(p);selected=new Set();dirty=!p.id;formTouched.clear();$('library').hidden=true;$('editor').hidden=false;$('notice').hidden=true;
  $('plate-name').value=current.plate;for(const key of meta)$(key).value=current.metadata?.[key]||'';
  updateElabLink();
  $('editor-title').textContent=current.plate||'New plate';$('save-state').textContent=current.id?'Saved · '+new Date(current.updated_at).toLocaleString('en-GB'):'Unsaved';
  $('revision').textContent=current.version?'Version '+current.version:'';
  $('trash-plate').hidden=!current.id;
  $('history').hidden=!current.id;$('source-download').hidden=!current.source_id;
  if(current.source_id)$('source-download').href='/api/sources/'+current.source_id;
  $('download-table').href='/api/export/plates?id='+current.id;$('download-map').href='/api/export/platemaps?id='+current.id;updateLinks();
  const warnings=(current.warnings||[]).map(englishImportWarning);$('warning-box').hidden=!warnings.length;$('warning-summary').textContent='Source notes: '+warnings.length;$('warnings').replaceChildren(...warnings.map(w=>element('li',w)));
  $('view-field').value='ID';renderGrid();renderForm();setEditMode(editMode);scheduleGeneCheck();window.scrollTo(0,0);
}
function setEditMode(mode){
  if(formTouched.size)applyWells();
  editMode=mode;
  $('sheet-panel').hidden=mode!=='sheet';$('map-panel').hidden=mode!=='map';
  $('mode-sheet').setAttribute('aria-pressed',String(mode==='sheet'));$('mode-map').setAttribute('aria-pressed',String(mode==='map'));
  if(mode==='sheet')renderSheet();else{renderGrid();renderForm();}
}
function changeSheet(changes){
  const changed=changes.filter(c=>current.wells[c.loc][c.key]!==c.value);
  if(!changed.length)return 0;
  const undo=changed.map(c=>({...c,value:current.wells[c.loc][c.key]}));undo.approvals=structuredClone(current.label_approvals||[]);sheetUndo.push(undo);
  if(sheetUndo.length>50)sheetUndo.shift();
  for(const c of changed){current.wells[c.loc][c.key]=c.value;if(['Gene_intron','Cell_Line_Stock','Cell_type'].includes(c.key))invalidateApprovals(c.loc);}
  markDirty();$('sheet-undo').disabled=false;
  if(changed.some(c=>['Gene_intron','Cell_Line_Stock','Cell_type'].includes(c.key)))scheduleGeneCheck();
  $('sheet-status').textContent=changed.length+' cells changed. Save changes to keep them.';
  return changed.length;
}
function renderSheet(){
  editingCell=null;
  const visible=sheetGroups[$('sheet-group').value];
  const table=$('well-sheet'), head=element('tr');
  const wellHead=element('th','Location');wellHead.scope='col';head.append(wellHead);
  visible.forEach((key,c)=>{const th=element('th',shortLabels[fields.indexOf(key)]);th.scope='col';th.title=labels[fields.indexOf(key)];th.tabIndex=0;th.onclick=()=>{anchor={r:0,c};rangeEnd={r:95,c};paintRange();};th.onkeydown=e=>{if(e.key==='Enter')th.click();};head.append(th);});
  table.tHead.replaceChildren(head);const body=table.tBodies[0];body.replaceChildren();
  locations.forEach((loc,r)=>{const row=element('tr'), name=element('th',loc);name.scope='row';row.append(name);
    name.onclick=()=>{anchor={r,c:0};rangeEnd={r,c:visible.length-1};paintRange();};
    visible.forEach((key,c)=>{const td=element('td'),input=element('textarea');input.rows=1;input.readOnly=true;input.spellcheck=false;input.maxLength=5000;input.value=current.wells[loc][key];input.setAttribute('aria-label',loc+' '+labels[fields.indexOf(key)]);input.dataset.row=r;input.dataset.col=c;input.title=input.value;
      let typing=false;
      input.onfocus=()=>{typing=false;if(!dragging){anchor={r,c};rangeEnd={r,c};paintRange();}};
      input.onpointerdown=e=>{if(editingCell===input)return;e.preventDefault();const old=anchor;dragging=true;input.focus();anchor=e.shiftKey&&old?old:{r,c};rangeEnd={r,c};paintRange();};
      input.onpointerenter=()=>{if(dragging){rangeEnd={r,c};paintRange();}};
      input.ondblclick=()=>startCellEdit(input);
      input.oninput=()=>{if(!typing){typing=!!changeSheet([{loc,key,value:input.value}]);}else{current.wells[loc][key]=input.value;if(['Gene_intron','Cell_Line_Stock','Cell_type'].includes(key))invalidateApprovals(loc);markDirty();}input.title=input.value;showActiveCell();};
      input.onblur=()=>{if(editingCell===input)finishCellEdit(input,loc,key);};
      input.oncompositionstart=()=>{if(input.readOnly)startCellEdit(input);};
      input.onkeydown=e=>{
        if(e.isComposing)return;
        if(editingCell===input){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();finishCellEdit(input,loc,key);focusCell(Math.min(r+1,95),c);}else if(e.key==='Escape'){e.preventDefault();finishCellEdit(input,loc,key);}return;}
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();anchor={r:0,c:0};rangeEnd={r:95,c:visible.length-1};paintRange();return;}
        if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();clearRange();return;}
        const steps={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1],Enter:[1,0]};
        if(steps[e.key]){e.preventDefault();const d=steps[e.key],end=e.shiftKey&&rangeEnd?rangeEnd:{r,c},old=anchor;const nr=Math.max(0,Math.min(95,end.r+d[0])),nc=Math.max(0,Math.min(visible.length-1,end.c+d[1]));if(e.shiftKey){rangeEnd={r:nr,c:nc};anchor=old||{r,c};paintRange();}else focusCell(nr,nc);return;}
        if(e.key==='F2'){e.preventDefault();startCellEdit(input);return;}
        if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){startCellEdit(input);input.select();}
      };
      input.oncopy=e=>{if(editingCell!==input&&anchor){e.preventDefault();e.clipboardData.setData('text/plain',rangeText());}};
      input.oncut=e=>{if(editingCell!==input&&anchor){e.preventDefault();e.clipboardData.setData('text/plain',rangeText());clearRange();}};
      input.onpaste=e=>{const text=e.clipboardData.getData('text/plain');if(editingCell===input&&!/[\t\n\r]/.test(text))return;e.preventDefault();try{
        const bounds=selectionBounds()||{r0:r,c0:c,r1:r,c1:c};const matrix=SheetTools.parseTSV(text);
        if(matrix.some(row=>row.some(value=>value.length>5000)))throw Error('Use no more than 5,000 characters per cell.');
        const changes=matrix.length===1&&matrix[0].length===1?(matrix[0][0]===''&&$('skip-blank').checked?[]:rangeChanges(matrix[0][0])):SheetTools.planPaste(text,bounds.r0,bounds.c0,locations,visible,$('skip-blank').checked);
        const normalized=changes.map(x=>({...x,value:normalizedLabel(x.key,x.value)}));
        const n=changeSheet(normalized);renderSheet();$('sheet-status').textContent=n+' cells pasted. Save changes to keep them.';scheduleGeneCheck();
      }catch(error){notice(error.message,true);}};
      td.append(input);row.append(td);
    });body.append(row);
  });$('sheet-undo').disabled=!sheetUndo.length;paintRange();paintGeneFlags();
}
function focusCell(r,c){const input=$('well-sheet').querySelector(`textarea[data-row="${r}"][data-col="${c}"]`);if(input){input.focus();input.scrollIntoView({block:'nearest',inline:'nearest'});}}
function startCellEdit(input){editingCell=input;input.readOnly=false;input.classList.add('editing');input.focus();}
function finishCellEdit(input,loc,key){if(['Gene_intron','Cell_Line_Stock','Cell_type'].includes(key)){const value=normalizedLabel(key,input.value);if(value!==input.value){changeSheet([{loc,key,value}]);input.value=value;$('sheet-status').textContent=loc+': normalized to '+value+'.';}scheduleGeneCheck();}input.readOnly=true;input.classList.remove('editing');editingCell=null;showActiveCell();}
function selectionBounds(){return anchor&&rangeEnd?SheetTools.rectangle(anchor,rangeEnd):null;}
function rangeChanges(value){const b=selectionBounds();if(!b)return [];const visible=sheetGroups[$('sheet-group').value],result=[];for(let r=b.r0;r<=b.r1;r++)for(let c=b.c0;c<=b.c1;c++)result.push({loc:locations[r],key:visible[c],value});return result;}
function rangeText(){const b=selectionBounds();if(!b)return '';const visible=sheetGroups[$('sheet-group').value],rows=[];for(let r=b.r0;r<=b.r1;r++){const row=[];for(let c=b.c0;c<=b.c1;c++)row.push(current.wells[locations[r]][visible[c]]);rows.push(row);}return SheetTools.serializeTSV(rows);}
function paintRange(){const b=selectionBounds();for(const input of $('well-sheet').querySelectorAll('textarea')){const r=Number(input.dataset.row),c=Number(input.dataset.col);input.parentElement.classList.toggle('range-selected',!!b&&r>=b.r0&&r<=b.r1&&c>=b.c0&&c<=b.c1);}const n=b?(b.r1-b.r0+1)*(b.c1-b.c0+1):0;$('range-label').textContent=n?n+' cells selected':'No cells selected';$('sheet-copy').disabled=!n;$('sheet-clear').disabled=!n;showActiveCell();}
function showActiveCell(){if(!anchor)return;const key=sheetGroups[$('sheet-group').value][anchor.c];if(!key)return;$('active-cell-label').textContent=locations[anchor.r]+' / '+labels[fields.indexOf(key)];$('active-cell-value').textContent=current.wells[locations[anchor.r]][key]||'(empty)';}
function clearRange(){const n=changeSheet(rangeChanges(''));renderSheet();$('sheet-status').textContent=n+' cells cleared. Use Undo table edit to restore them.';scheduleGeneCheck();}
function updateElabLink(){const id=$('elab_experiment_id').value.trim(),valid=/^[0-9]{1,20}$/.test(id);$('elab-link').hidden=!valid;$('elab-error').hidden=!id||valid;if(valid)$('elab-link').href='https://makimono.elab.one/experiments.php?mode=view&id='+encodeURIComponent(id);else $('elab-link').removeAttribute('href');}
function scheduleGeneCheck(){clearTimeout(geneTimer);const seq=++geneSequence;geneTimer=setTimeout(async()=>{try{const report=await api('/api/gene-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wells:current.wells,label_approvals:current.label_approvals||[]})});if(seq!==geneSequence)return;geneReport=report;renderGeneReport();}catch(e){if(seq===geneSequence){$('gene-summary').textContent='Gene and stock checks are incomplete';$('gene-reference').textContent=e.message;}}},250);}
function renderGeneReport(){const issues=geneReport.issues||[],corrections=geneReport.corrections||[],approved=geneReport.approved||[];$('gene-summary').textContent=`Gene / stock checks: ${issues.length} to review / ${corrections.length} corrections / ${approved.length} approved`;$('gene-reference').textContent=(geneReport.reference||'')+' '+(geneReport.reference_warning||'');$('gene-issues').replaceChildren();
  for(const i of [...issues,...corrections,...approved]){const field=i.field||'Gene_intron',li=element('li'),jump=element('button',i.loc+' '+field);jump.onclick=()=>{setEditMode('sheet');$('sheet-group').value='cells';anchor=null;rangeEnd=null;renderSheet();focusCell(locations.indexOf(i.loc),field==='Gene_intron'?2:1);};li.append(jump,document.createTextNode(' '+(i.before?i.before+' → '+i.after:i.value+': '+i.message)));
    if(i.approval){const a=i.approval;li.append(element('span',` ✓ Shared approval: ${a.reason} (${a.approved_by})`));const edit=element('button','Edit approval');edit.onclick=()=>openRuleEditor(a);li.append(edit);
    }else if(!i.before){const approve=element('button','Review / approve');approve.setAttribute('aria-label',i.loc+' '+field+': review and approve');approve.onclick=()=>openApproval({...i,field});li.append(approve);} $('gene-issues').append(li);
  }paintGeneFlags();}
function paintGeneFlags(){const visible=sheetGroups[$('sheet-group').value];for(const field of ['Gene_intron','Cell_Line_Stock']){const col=visible.indexOf(field);if(col<0)continue;for(const input of $('well-sheet').querySelectorAll(`textarea[data-col="${col}"]`)){const loc=locations[Number(input.dataset.row)],matches=i=>i.loc===loc&&(i.field||'Gene_intron')===field,issue=geneReport.issues?.find(matches),correction=geneReport.corrections?.find(matches),approved=geneReport.approved?.find(matches);input.parentElement.classList.toggle('gene-flag',!!issue||!!correction);input.parentElement.classList.toggle('label-approved',!!approved);input.title=issue?'⚑ '+issue.message:correction?'⚑ Suggested normalization: '+correction.after:approved?'✓ Approved: '+approved.approval.reason:input.value;}}}
function openApproval(item){approvalItem={...item,value:current.wells[item.loc][item.field]};$('approval-description').textContent=item.loc+' / '+item.field+': '+item.message;$('approval-value').value=approvalItem.value;$('approval-reason').value='';$('approval-all').checked=false;$('approval-status').textContent='';$('approval-dialog').showModal();}
function normalizeAllGenes(){const changes=locations.flatMap(loc=>['Gene_intron','Cell_Line_Stock'].map(key=>({loc,key,value:normalizedLabel(key,current.wells[loc][key])})));const n=changeSheet(changes);renderSheet();renderGrid();scheduleGeneCheck();$('sheet-status').textContent=n+' labels normalized. Ambiguous gene names and numbers were left unchanged.';}
function newPlate(){if(!canLeave())return;openEditor({plate:'',metadata:{},wells:Object.fromEntries(locations.map(l=>[l,Object.fromEntries(fields.map(f=>[f,'']))]))});}
function toggleLocations(locs,add=false){
  if(formTouched.size && !confirm('Discard unapplied well edits and change the selection?'))return;
  if(!add)selected=new Set(locs);else{const remove=locs.every(l=>selected.has(l));locs.forEach(l=>remove?selected.delete(l):selected.add(l));}renderGrid();renderForm();
}
function renderGrid(){
  const grid=$('plate-grid');grid.replaceChildren(element('span',''));const view=$('view-field').value;
  for(let c=1;c<=12;c++){const b=element('button',String(c),'axis');b.title=c+': select column';b.onclick=()=>toggleLocations([...'ABCDEFGH'].map(r=>r+c));grid.append(b);}
  for(const r of 'ABCDEFGH'){
    const axis=element('button',r,'axis');axis.title=r+': select row';axis.onclick=()=>toggleLocations(Array.from({length:12},(_,c)=>r+(c+1)));grid.append(axis);
    for(let c=1;c<=12;c++){const loc=r+c,w=current.wells[loc],v=view==='legacy'?(current.legacy_map?.[loc]||''):w[view];const b=element('button',undefined,'well');b.classList.toggle('used',used(w));b.classList.toggle('selected',selected.has(loc));b.setAttribute('aria-pressed',String(selected.has(loc)));b.setAttribute('aria-label',loc+' '+(v||'empty'));b.title=loc+'\n'+fields.map((f,i)=>labels[i]+': '+(w[f]||'—')).join('\n');b.append(element('span',loc,'loc'),element('span',v||'·','value'));b.onclick=e=>toggleLocations([loc],e.shiftKey||e.metaKey||e.ctrlKey);grid.append(b);}
  }
  $('used-count').textContent=Object.values(current.wells).filter(used).length+' / 96 wells';$('selected-count').textContent=selected.size+' wells selected';$('selection-label').textContent=selected.size===1?[...selected][0]:selected.size+' wells';
}
function renderForm(){
  formTouched.clear();$('well-fields').replaceChildren();
  fields.forEach((key,i)=>{const label=element('label',labels[i]);const input=element('input');input.name=key;input.disabled=!selected.size;input.value=selected.size===1?current.wells[[...selected][0]][key]:'';input.placeholder=selected.size>1?'Leave unchanged':(key==='Conditions'?'For example: NOSTRESS / treatment, concentration, duration':'');input.maxLength=5000;input.oninput=()=>{formTouched.add(key);updateLinks();};label.append(input);$('well-fields').append(label);});updateLinks();
}
function applyWells(){
  if(!selected.size){notice('Select a well first.',true);return false;}
  for(const key of formTouched){const raw=$('well-form').elements.namedItem(key).value,value=normalizedLabel(key,raw);for(const loc of selected){current.wells[loc][key]=value;if(['Gene_intron','Cell_Line_Stock','Cell_type'].includes(key))invalidateApprovals(loc);}}
  if(formTouched.size){markDirty();sheetUndo=[];}renderGrid();renderForm();scheduleGeneCheck();return true;
}
function gather(){current.plate=$('plate-name').value.trim();current.metadata={...current.metadata,...Object.fromEntries(meta.map(k=>[k,$(k).value.trim()]))};return current;}
async function save(){
  if(formTouched.size && !applyWells())return;
  const payload=gather();if(!payload.plate || !payload.metadata.experimenter){notice('Enter the plate name and experimenter.',true);return;}
  $('save').disabled=true;$('editor').inert=true;
  try{const saved=await api('/api/plates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});openEditor(saved);notice('Plate saved. Excel downloads are now available.');await refreshLibrary();}finally{$('save').disabled=false;$('editor').inert=false;}
}
function showImport(){if(!canLeave())return;$('import-dialog').showModal();}
function importDetail(){const p=imported.plates[Number($('import-select').value)];$('import-detail').textContent=p.used+' / 96 wells populated · Source notes: '+p.warnings.length+'';}
async function upload(){
  const file=$('import-file').files[0];if(!file)return;
  if(file.size>12*1024*1024){$('import-status').textContent='Select a file no larger than 12 MB.';return;}
  $('import-preview').hidden=true;$('import-status').textContent='Reading Excel file…';$('import-file').disabled=true;
  try{const form=new FormData();form.append('file',file);imported=await api('/api/import',{method:'POST',body:form});$('import-select').replaceChildren(...imported.plates.map((p,i)=>{const o=element('option',p.plate+'('+p.used+' wells)');o.value=i;return o;}));$('import-status').textContent=imported.plates.length+' plates found. '+imported.warnings.join(' ');$('import-preview').hidden=false;importDetail();}
  catch(e){$('import-status').textContent=e.message;}finally{$('import-file').disabled=false;}
}
$('new-plate').onclick=newPlate;$('new-top').onclick=newPlate;
$('show-library').onclick=safe(async()=>{if(!canLeave())return;dirty=false;formTouched.clear();$('editor').hidden=true;$('library').hidden=false;$('notice').hidden=true;await refreshLibrary();});
$('search').oninput=renderLibrary;for(const id of ['import-open','import-empty'])$(id).onclick=showImport;
$('import-close').onclick=()=>$('import-dialog').close();$('import-file').onchange=upload;$('import-select').onchange=importDetail;
$('import-use').onclick=()=>{const p=structuredClone(imported.plates[Number($('import-select').value)]);p.source_id=imported.source_id;p.source_plate=p.plate;$('import-dialog').close();openEditor(p);};
$('view-field').onchange=renderGrid;$('select-all').onclick=()=>{if(formTouched.size&&!confirm('Discard unapplied edits?'))return;selected=new Set(locations);renderGrid();renderForm();};
$('select-none').onclick=()=>{if(formTouched.size&&!confirm('Discard unapplied edits?'))return;selected.clear();renderGrid();renderForm();};
$('well-form').onsubmit=e=>{e.preventDefault();if(applyWells())notice('Changes applied to the selected wells. Save the plate to keep them.');};
$('clear-wells').onclick=()=>{if(!selected.size)return;if(!confirm(selected.size+' wells: clear all information?'))return;for(const loc of selected){current.wells[loc]=Object.fromEntries(fields.map(f=>[f,'']));invalidateApprovals(loc);}sheetUndo=[];markDirty();renderGrid();renderForm();};
for(const id of ['plate-name',...meta])$(id).oninput=()=>{markDirty();if(id==='elab_experiment_id')updateElabLink();};
$('save').onclick=safe(save);
$('sheet-save').onclick=safe(save);
$('mode-sheet').onclick=()=>setEditMode('sheet');$('mode-map').onclick=()=>setEditMode('map');
$('sheet-group').onchange=()=>{anchor=null;rangeEnd=null;renderSheet();};
function undoSheet(){const changes=sheetUndo.pop();if(!changes)return;editingCell=null;for(const c of changes)current.wells[c.loc][c.key]=c.value;if(changes.approvals)current.label_approvals=changes.approvals;markDirty();renderSheet();if(anchor)focusCell(anchor.r,anchor.c);scheduleGeneCheck();$('sheet-status').textContent='Last table edit undone. Save the plate to update the database.';}
$('sheet-undo').onclick=undoSheet;
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!e.shiftKey&&!e.isComposing&&!$('editor').hidden&&(e.target.closest('#sheet-panel')||(e.target===document.body&&editMode==='sheet'&&anchor))&&!document.querySelector('dialog[open]')){e.preventDefault();undoSheet();}},true);
$('sheet-scale').onchange=()=>{$('sheet-scroll').dataset.scale=$('sheet-scale').value;};
$('compact-sheet').onchange=()=>{$('sheet-scroll').classList.toggle('compact',$('compact-sheet').checked);};
$('wide-sheet').onclick=()=>{const on=document.body.classList.toggle('wide-sheet');$('wide-sheet').textContent=on?'Standard width':'Wide view';};
$('sheet-clear').onclick=clearRange;
$('sheet-copy').onclick=safe(async()=>{await navigator.clipboard.writeText(rangeText());$('sheet-status').textContent='Selection copied. You can paste it into Excel.';});
$('normalize-genes').onclick=normalizeAllGenes;
document.addEventListener('pointerup',()=>{dragging=false;});document.addEventListener('pointercancel',()=>{dragging=false;});
$('duplicate').onclick=()=>{if(formTouched.size)applyWells();const copy=structuredClone(gather());delete copy.id;delete copy.version;delete copy.updated_at;copy.plate=copy.plate+'-copy';openEditor(copy);notice('Copy created. Check the plate name and metadata before saving.');};
$('history').onclick=safe(async()=>{const rows=await api('/api/plates/'+current.id+'/history');$('history-list').replaceChildren(...rows.map(r=>{const div=element('div',undefined,'history-row');div.append(element('b','Version '+r.version+' · '+({save:'Saved',trash:'Moved to Trash',restore:'Restore'}[r.action]||'Saved')),element('p',new Date(r.saved_at).toLocaleString('en-GB')+' · '+r.data.metadata.experimenter));const b=element('button','Open a copy of this version');b.onclick=()=>{if(!canLeave())return;$('history-dialog').close();openEditor({...r.data,plate:r.data.plate+'-v'+r.version+'-copy'});};div.append(b);return div;}));$('history-dialog').showModal();});
$('history-close').onclick=()=>$('history-dialog').close();
$('trash-open').onclick=safe(async()=>{$('trash-dialog').showModal();await renderTrash();});
$('trash-close').onclick=()=>$('trash-dialog').close();
$('trash-plate').onclick=safe(async()=>{
  if(!current?.id)return;
  const unsaved=dirty||formTouched.size;
  if(!confirm(`Move ${current.plate} to Trash?\nYou can restore it from Trash.${unsaved?'\nUnsaved changes will be discarded. The last saved version will be kept in Trash.':''}`))return;
  $('editor').inert=true;
  try{
    await api('/api/plates/'+current.id+'/trash',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:current.version})});
    dirty=false;formTouched.clear();clearTimeout(geneTimer);geneSequence++;current=null;
    $('editor').hidden=true;$('library').hidden=false;document.body.classList.remove('wide-sheet');$('wide-sheet').textContent='Wide view';
    await refreshLibrary();notice('Plate moved to Trash. You can restore it from Trash in the sidebar.');
  }finally{$('editor').inert=false;}
});
async function renderTrash(){
  $('trash-status').textContent='Loading…';
  try{
    const rows=await api('/api/trash');$('trash-list').replaceChildren();$('trash-status').textContent=rows.length?rows.length+' plates':'Trash is empty.';
    for(const p of rows){const row=element('div',undefined,'trash-row'),info=element('div');info.append(element('b',p.plate),element('p',new Date(p.deleted_at).toLocaleString('en-GB')+' · deleted','muted'));const restore=element('button','Restore');restore.setAttribute('aria-label',p.plate+': restore');restore.onclick=async()=>{
      restore.disabled=true;
      try{await api('/api/plates/'+p.id+'/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:p.version})});await renderTrash();await refreshLibrary();$('trash-status').textContent=p.plate+' restored.';}
      catch(e){$('trash-status').textContent=e.message;restore.disabled=false;}
    };const purge=element('button','Delete permanently','trash-button');purge.setAttribute('aria-label',p.plate+': permanently delete');purge.onclick=()=>{purgeItem=p;$('purge-name').value='';$('purge-status').textContent='';$('purge-description').textContent=p.plate+' will be permanently deleted, including all plate history and uploaded originals not referenced elsewhere.';$('purge-dialog').showModal();};const actions=element('div',undefined,'actions');actions.append(restore,purge);row.append(info,actions);$('trash-list').append(row);}
  }catch(e){$('trash-status').textContent=e.message;}
}
$('purge-close').onclick=()=>$('purge-dialog').close();
$('purge-confirm').onclick=async()=>{if(!purgeItem)return;if($('purge-name').value!==purgeItem.plate){$('purge-status').textContent='Enter the exact plate name.';return;}$('purge-confirm').disabled=true;try{await api('/api/plates/'+purgeItem.id+'/purge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:purgeItem.version,confirm_name:$('purge-name').value})});$('purge-dialog').close();await renderTrash();$('trash-status').textContent=purgeItem.plate+' permanently deleted.';purgeItem=null;}catch(e){$('purge-status').textContent=e.message;}finally{$('purge-confirm').disabled=false;}};
$('approval-close').onclick=()=>$('approval-dialog').close();
window.addEventListener('beforeunload',e=>{if(dirty||formTouched.size){e.preventDefault();e.returnValue='';}});
safe(refreshLibrary)();
