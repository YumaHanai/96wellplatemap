'use strict';
let wellRows=[],sharedRules=[],editingRule=null;
function showRegistryPanel(id){
  if(!canLeave())return false;
  dirty=false;formTouched.clear();clearTimeout(geneTimer);geneSequence++;current=null;
  for(const panel of ['library','editor','all-wells','shared-approvals'])$(panel).hidden=panel!==id;
  for(const [button,panel] of [['show-library','library'],['show-wells','all-wells'],['show-approvals','shared-approvals']])$(button).classList.toggle('active',id===panel);
  document.body.classList.remove('wide-sheet');$('wide-sheet').textContent='Wide view';$('notice').hidden=true;window.scrollTo(0,0);return true;
}
$('show-library').onclick=safe(async()=>{if(showRegistryPanel('library'))await refreshLibrary();});
$('show-wells').onclick=safe(async()=>{if(showRegistryPanel('all-wells'))await loadAllWells();});
$('reload-wells').onclick=safe(loadAllWells);
async function loadAllWells(){
  $('well-results').textContent='Loading…';wellRows=await api('/api/wells');renderAllWells();
}
function renderAllWells(){
  const rows=wellRows.filter(r=>($('include-empty').checked||used(r.well))&&SheetTools.matchesWell(r,$('well-search').value,$('well-match').value==='exact'));
  $('well-results').textContent=rows.length+' wells / '+new Set(rows.map(r=>r.plate_id)).size+' plates (total: '+wellRows.length+' wells)';
  const head=element('tr');for(const title of ['Plate / Well',...shortLabels,'Experimenter','Fixation conditions','Storage location','eLabFTW ID'])head.append(element('th',title));
  $('all-well-table').tHead.replaceChildren(head);
  const fragment=document.createDocumentFragment();
  for(const r of rows){const tr=element('tr'),linkCell=element('td'),open=element('button',r.plate+' / '+r.loc);open.onclick=safe(async()=>{
    openEditor(await api('/api/plates/'+r.plate_id));setEditMode('sheet');focusCell(locations.indexOf(r.loc),2);
  });linkCell.append(open);tr.append(linkCell);
    for(const key of fields)tr.append(element('td',r.well[key]));
    for(const key of ['experimenter','fixation','storage'])tr.append(element('td',r.metadata[key]||''));
    const note=element('td'),id=r.metadata.elab_experiment_id;if(id&&/^[0-9]+$/.test(id)){const a=element('a',id);a.href='https://makimono.elab.one/experiments.php?mode=view&id='+id;a.target='_blank';a.rel='noopener noreferrer';note.append(a);}tr.append(note);fragment.append(tr);
  }
  $('all-well-table').tBodies[0].replaceChildren(fragment);
}
for(const id of ['well-search','well-match','include-empty'])$(id).addEventListener(id==='well-search'?'input':'change',renderAllWells);
$('show-approvals').onclick=safe(async()=>{if(showRegistryPanel('shared-approvals'))await loadRules();});
async function loadRules(){sharedRules=await api('/api/approvals');renderRules();}
function renderRules(){
  const q=$('rule-search').value.toLowerCase(),rows=sharedRules.filter(a=>[a.field,a.value,a.reason,a.approved_by].join(' ').toLowerCase().includes(q));
  $('rule-count').textContent=rows.length+' entries (enabled: '+rows.filter(a=>a.enabled).length+')';
  $('rule-list').replaceChildren(...rows.map(a=>{const tr=element('tr');for(const value of [a.field,a.value,a.reason,a.approved_by,a.approved_at?new Date(a.approved_at).toLocaleString('en-GB'):'—',a.enabled?'Enabled':'Disabled'])tr.append(element('td',value));const td=element('td'),edit=element('button','Edit');edit.setAttribute('aria-label',a.field+' '+a.value+' approval: edit');edit.onclick=()=>openRuleEditor(a);td.append(edit);tr.append(td);return tr;}));
}
$('rule-search').oninput=renderRules;
$('add-rule').onclick=()=>openRuleEditor();
function openRuleEditor(rule){
  editingRule=rule?structuredClone(rule):null;
  $('rule-field').value=rule?.field||'Cell_Line_Stock';$('rule-value').value=rule?.value||'';$('rule-reason').value=rule?.reason||'';$('rule-author').value=rule?.approved_by||'';$('rule-enabled').checked=rule?!!rule.enabled:true;$('rule-status').textContent='';$('rule-dialog').showModal();
}
$('rule-close').onclick=()=>$('rule-dialog').close();
$('rule-save').onclick=async()=>{
  $('rule-save').disabled=true;
  try{await api('/api/approvals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...editingRule,field:$('rule-field').value,value:$('rule-value').value,reason:$('rule-reason').value,approved_by:$('rule-author').value,enabled:$('rule-enabled').checked})});$('rule-dialog').close();await loadRules();if(current&&!$('editor').hidden)scheduleGeneCheck();}
  catch(e){$('rule-status').textContent=e.message;}finally{$('rule-save').disabled=false;}
};
$('approval-confirm').onclick=async()=>{
  if(!approvalItem)return;
  const item=approvalItem,value=normalizedLabel(item.field,$('approval-value').value.trim()),reason=$('approval-reason').value.trim(),author=$('experimenter').value.trim();
  if(!value||!reason||!author){$('approval-status').textContent='Enter the approved value, reason and experimenter name in the plate information.';return;}
  $('approval-confirm').disabled=true;
  try{
    const rules=await api('/api/approvals'),existing=rules.find(a=>a.field===item.field&&a.value===value);
    if(!existing?.enabled)await api('/api/approvals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...existing,field:item.field,value,reason,approved_by:author,enabled:true})});
    const cellType=current.wells[item.loc].Cell_type;
    const locs=$('approval-all').checked?locations.filter(loc=>current.wells[loc][item.field]===item.value&&current.wells[loc].Cell_type===cellType):[item.loc];
    const changed=changeSheet(locs.map(loc=>({loc,key:item.field,value})));
    renderSheet();renderGrid();scheduleGeneCheck();$('approval-dialog').close();
    $('sheet-status').textContent='Shared approval saved. The same field and label will not be flagged on any plate. '+(changed?'Save the plate to keep the updated well values.':'');
  }catch(e){$('approval-status').textContent=e.message;}finally{$('approval-confirm').disabled=false;}
};
// A tab returning from another editor picks up changed shared approvals.
window.addEventListener('focus',()=>{if(current&&!$('editor').hidden)scheduleGeneCheck();});
