const $ = (s) => document.querySelector(s);
$('#ai-plan').textContent = 'AI 整理（DeepSeek）';
let draftOwner = null;
let heartbeatImages = [];
let heartbeatArchives = [];
let user = null, items = [], groupCache = [], busy = false, selected = null, actionImages = [], actionFiles = [], appendGroupId = null, appendRequestId = null, audio = null, sound = false, offset = 0, lastPhase = null, playing = [];
const apiBase = new URL(location.pathname.endsWith('/employee/') ? '../api/employee/' : 'api/employee/', location.href);
const taskApiRoot = new URL('../', apiBase);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function notice(text, error=false){$('#notice').textContent=text;$('#notice').className=error?'error':'';}
async function api(path, data){
  const response=await fetch(new URL(path,apiBase),data?{method:'POST',headers:{'Content-Type':'application/json','X-Team-Request':'employee'},body:JSON.stringify(data)}:{cache:'no-store'});
  const value=await response.json().catch(()=>({error:response.status===413?'图片合计过大，服务器未接收，请减少图片后重试。':'服务器响应异常，请重试。'}));
  if(!response.ok){if(response.status===401){user=null;$('#workspace').hidden=true;$('#welcome').hidden=false;}throw Error(value.error||'提交失败，请重试');}
  return value;
}
function tab(name){for(const n of ['todo','work','end']){$('#'+n).hidden=n!==name;document.querySelector('[data-tab='+n+']').setAttribute('aria-selected',String(n===name));}}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.tab));
const views = ['my-tasks','hb','work-tools'];
function showView(name, updateUrl=false){
  if(!views.includes(name))name='my-tasks';
  for(const key of views){
    $('#'+key).hidden=key!==name;
    const button=document.querySelector('[data-view="'+key+'"]');
    button.setAttribute('aria-selected',String(key===name));
    button.tabIndex=key===name?0:-1;
  }
  if(updateUrl)history.replaceState(null,'','#'+name);
}
document.querySelectorAll('[data-view]').forEach(button=>{
  button.onclick=()=>showView(button.dataset.view,true);
  button.onkeydown=e=>{
    const i=views.indexOf(button.dataset.view);
    const next=e.key==='ArrowRight'?(i+1)%views.length:e.key==='ArrowLeft'?(i+views.length-1)%views.length:e.key==='Home'?0:e.key==='End'?views.length-1:null;
    if(next===null)return;
    e.preventDefault();showView(views[next],true);document.querySelector('[data-view="'+views[next]+'"]').focus();
  };
});
window.addEventListener('hashchange',()=>showView(location.hash.slice(1)));
showView(location.hash.slice(1));
function storage(key,value){try{if(value!==undefined)localStorage.setItem(key,value);else return localStorage.getItem(key);}catch{return null;}}
function reworks(){
  if(!sound||!user)return;
  let seen=[];try{seen=JSON.parse(storage('rework:'+user)||'[]');if(!Array.isArray(seen))seen=[];}catch{}
  const fresh=items.filter(t=>t.status==='需修改'&&!seen.includes(t.id+':'+t.rework_count));
  if(fresh.length){chime('rework');notice('有任务需要修改：'+fresh.map(t=>t.title).join('、'));storage('rework:'+user,JSON.stringify([...seen,...fresh.map(t=>t.id+':'+t.rework_count)]));}
}
function renderPersonal(data){
  const scores=data.scores||[],completed=data.completed||[],progress=data.progress||[];
  const todayPoints=scores.find(r=>r.date===data.date)?.points||0;
  const total=Math.round(scores.reduce((n,r)=>n+r.points,0)*100)/100;
  const high=data.tasks.find(t=>t.priority==='高');
  $('#personal-name').textContent='当前姓名：'+data.name;
  $('#personal-role').textContent=data.is_admin?'管理员权限已启用':'成员工作台';
  $('#owner-dashboard').hidden=data.member!=='YWH';
  $('#owner-dashboard').href=new URL('../..',apiBase).href;
  $('#personal-summary').innerHTML='<div><small>今日审核得分</small><strong>'+todayPoints+' 点</strong></div><div><small>近 7 天得分</small><strong>'+total+' 点</strong></div><div><small>等待审核</small><strong>'+data.tasks.filter(t=>t.status==='待验收').length+' 项</strong></div><div><small>当前高优先</small><strong>'+esc(high?.title||'暂无')+'</strong></div>';
  $('#personal-scores').innerHTML=scores.slice().reverse().map(r=>'<p>'+esc(r.date)+' · '+r.points+' 点'+(r.unscored_count?' · '+r.unscored_count+' 项尚未打分':'')+'</p>').join('');
  $('#personal-completed').innerHTML=completed.length?completed.map(t=>'<article><h3>'+esc(t.title)+'</h3><p>'+esc(t.awarded_points==null?'尚未打分':t.awarded_points+' 点')+' · '+(t.completed_at?new Date(t.completed_at).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'}):'历史任务')+'</p><p>'+esc(t.result_summary||'')+'</p><p>'+esc(t.acceptance_result||'')+'</p>'+taskAttachmentGallery(t.attachments,taskApiRoot)+'</article>').join(''):'<p>还没有审核通过的任务。</p>';
  $('#personal-progress').innerHTML=progress.length?progress.map(p=>'<article><h3>'+esc(p.title)+'</h3><p>'+esc(p.report_status)+' · '+esc(p.summary)+'</p><small>'+reportTimestamp(p.created_at,data.date)+'</small>'+reportImageGallery(p.images,new URL('../',apiBase))+reportFileGallery(p.attachments,new URL('../',apiBase))+'</article>').join(''):'<p>还没有进展记录。</p>';
}
async function refresh(){
  const data=await api('me');user=data.name;items=data.tasks;offset=data.server_time-Date.now();
  if(draftOwner!==user){clearHeartbeatImages();$('#heartbeat').reset();draftOwner=user;workPlan=null;planRequestId=null;$('#work-text').value=storage('work-source:'+user)||'';previewWork();}
  $('#welcome').hidden=true;$('#workspace').hidden=false;$('#logout').hidden=false;$('#identity').textContent=user;$('#greeting').textContent=user+'，今天也一起加油。';
  renderPersonal(data);
  const running=items.filter(t=>t.status==='进行中'&&!t.is_paused);
  const selectedHeartbeat=$('#heartbeat-task').value;
  $('#heartbeat-task').innerHTML=running.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.title)+'</option>').join('');
  if(running.some(t=>t.id===selectedHeartbeat))$('#heartbeat-task').value=selectedHeartbeat;
  $('#task-count').textContent=items.length+' 项';$('#draft').value=storage('todo:'+user)||'';
  $('#end-status').textContent=items.some(t=>!['待验收','已完成'].includes(t.status))?'仍有待处理任务，请逐项完成。':'本轮任务均已提交，可以安心结束。';
  const renderTask = t => {
    let buttons='';
    let appendReason='';
    if(t.notes){try{const notes=JSON.parse(t.notes);appendReason=notes.append_reason||'';}catch{}}
    const button=(action,label)=>'<button data-id="'+t.id+'" data-action="'+action+'">'+label+'</button>';
    if(t.owner_inserted&&t.priority!=='高'&&!['已完成','待验收'].includes(t.status))buttons+=button('work_set_high_priority','标为高优先');
    if(t.status==='阻塞')buttons+=button('work_unblock_task','解除阻塞');
    if(['今日待办','需修改'].includes(t.status))buttons+=button('work_start_task','开始');
    if(t.status==='进行中'){buttons+=button(t.is_paused?'work_resume_task':'work_pause_task',t.is_paused?'继续':'暂停')+button('work_finish_task','提交这一项待验收');}
    if(t.status==='待验收')buttons+=button('work_withdraw_submission','取消待验收并重写');
    if(['今日待办','进行中','需修改'].includes(t.status))buttons+=button('work_block_task','遇到阻塞');
    return '<article class="task '+(t.priority==='高'?'high-priority':'')+'">'+(t.owner_inserted?'<p class="priority-label">'+(t.priority==='高'?'高优先 · 负责人临时插单':'负责人临时插单 · '+(t.status==='待验收'?'待审核':'可手动标高'))+' · 通常两小时以内</p>':'')+'<span class="badge">'+esc(t.is_paused?'已暂停':t.status==='进行中'&&running.length>1?'进行中 · 并行':t.status)+'</span><h3>'+esc(t.title)+'</h3><p>'+esc(t.type)+' · 预计 '+t.estimated_minutes+' 分钟 · 已记录 '+t.actual_minutes+' 分钟</p><p>'+esc(t.acceptance_result||t.blocked_reason||t.deliverable_expectation||t.acceptance_criteria||'')+'</p>'+(appendReason?'<p class="hint">补充原因：'+esc(appendReason)+'</p>':'')+taskAttachmentGallery(t.attachments,taskApiRoot)+'<div class="buttons">'+buttons+'</div></article>';
  };
  const groups = data.groups || [];
  groupCache = groups;
  const grouped = groups.map(g=>'<section class="task-group"><div class="group-heading"><span class="badge">'+esc(g.status)+'</span><h3>'+esc(g.title)+'</h3><p>验收通过 '+g.completed_count+' / '+g.total_count+' 项 · '+(g.stated_minutes==null?'未填写大任务参考时间':'大任务参考 '+g.stated_minutes+' 分钟')+' · 小任务合计 '+g.estimated_minutes+' 分钟 · 已记录 '+g.actual_minutes+' 分钟</p><p class="hint">小任务可独立估时，之后发现漏拆可随时补充；不要求与大任务参考时间一致。</p><p>'+esc(g.deliverable_expectation)+'</p><details><summary>整体验收标准</summary><p>'+esc(g.acceptance_criteria)+'</p></details><div class="buttons"><button type="button" data-append-group="'+esc(g.id)+'"'+(g.tasks.length>=8?' disabled':'')+'>'+(g.tasks.length>=8?'已达 8 项上限':'补充小任务')+'</button></div></div>'+g.tasks.map(renderTask).join('')+'</section>').join('');
  const singles = items.filter(t=>!t.group_id).map(renderTask).join('');
  $('#tasks').innerHTML=grouped+singles || '<div class="empty">还没有任务，先登记今天的工作吧。</div>';
  reworks();
}
async function run(action,args){
  if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{const result=await api('action',{action,args});notice(result.message);await refresh();return true;}
  catch(e){notice(e.message,true);return false;}
  finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);if(workPlan)checkPlan();else $('#confirm-plan').disabled=true;}
}
$('#login').onsubmit=async e=>{e.preventDefault();try{await api('login',{name:new FormData(e.target).get('name')});await refresh();notice('欢迎回来，'+user+'。');}catch(err){notice(err.message,true);}};
$('#logout').onclick=async()=>{if(busy)return;await api('logout',{});clearHeartbeatImages();clearActionImages();actionFiles=[];renderTaskFiles();$('#heartbeat').reset();user=null;draftOwner=null;workPlan=null;planRequestId=null;appendGroupId=null;appendRequestId=null;if($('#append-dialog').open)$('#append-dialog').close();$('#work-text').value='';renderPlan();$('#workspace').hidden=true;$('#welcome').hidden=false;$('#logout').hidden=true;$('#identity').textContent='我的工作台';};
$('#draft').oninput=e=>{storage('todo:'+user,e.target.value);$('#draft-saved').textContent='已保存在此浏览器';};
function parseWorkText(text){
  const labels={'任务名称':'title','任务类型':'type','预计分钟':'estimated_minutes','交付内容':'deliverable_expectation','验收标准':'acceptance_criteria'};
  const result={};let key=null;
  text=text.trim().replace(/^```[^\n]*\n/,'').replace(/\n```$/,'');
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();if(!line)continue;
    const match=line.match(/^(任务名称|任务类型|预计分钟|交付内容|验收标准)\s*[:：]\s*(.*)$/);
    if(match){key=labels[match[1]];if(Object.hasOwn(result,key))throw Error('每次请只粘贴一项任务，不能重复字段。');result[key]=match[2];}
    else if(key&&['deliverable_expectation','acceptance_criteria'].includes(key))result[key]+='\n'+line;
    else throw Error('请粘贴 MCP 提供的完整五字段工作描述，不要附加说明。');
  }
  for(const [label,field] of Object.entries(labels))if(!result[field]?.trim())throw Error('缺少“'+label+'”，请让 MCP 补齐后重新复制。');
  if(!['美术','测试','文档','配置','资料整理','AI任务','其他'].includes(result.type))throw Error('任务类型不正确，请让 MCP 使用约定类型。');
  if(!/^\d+(?:\s*分钟)?$/.test(result.estimated_minutes))throw Error('预计分钟须为 15–1440 的整数。');
  result.estimated_minutes=parseInt(result.estimated_minutes,10);
  if(result.estimated_minutes<15||result.estimated_minutes>1440)throw Error('预计分钟须为 15–1440 的整数。');
  for(const [field,max] of [['title',120],['deliverable_expectation',500],['acceptance_criteria',800]])if(result[field].length>max)throw Error('描述过长，请让 MCP 精简后重新复制。');
  return result;
}
let workPlan=null, planRequestId=null, planning=false;
function newRequestId(){return crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');}
function emptyTask(){return {title:'',type:'其他',estimated_minutes:null,deliverable_expectation:'',acceptance_criteria:''};}
function inputField(label,key,value,max,area=false){return '<label>'+label+(area?'<textarea':'<input')+' data-field="'+key+'" maxlength="'+max+'"'+(area?' rows="2">'+esc(value)+'</textarea>':' value="'+esc(value)+'">')+'</label>';}
function renderPlan(){
  const target=$('#work-preview');target.hidden=!workPlan;
  if(!workPlan){target.innerHTML='';$('#confirm-plan').disabled=true;return;}
  const g=workPlan.group;
  target.innerHTML='<div class="plan-parent"><h3>大任务</h3>'+inputField('任务名称','title',g.title,120)+inputField('整体交付内容','deliverable_expectation',g.deliverable_expectation,1000,true)+inputField('整体验收标准','acceptance_criteria',g.acceptance_criteria,1000,true)+'<label>预计总分钟（原文未提供可留空，仅作参考）<input data-total type="number" min="15" max="11520" step="1" value="'+esc(workPlan.stated_minutes??'')+'"></label><p class="hint">大任务时间是粗略参考，不要求等于小任务合计；每个小任务可独立估时。</p></div>'+
    (workPlan.warnings.length?'<aside class="plan-warnings"><strong>请核对</strong><ul>'+workPlan.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul><p>请将确认的信息补到下方任务中。</p></aside>':'')+
    '<h3>小任务 · 按执行顺序</h3>'+workPlan.tasks.map((t,i)=>'<fieldset class="plan-child" data-child="'+i+'"><legend>小任务 '+(i+1)+'</legend>'+inputField('任务名称','title',t.title,120)+'<div class="plan-row"><label>类型<select data-field="type">'+['美术','测试','文档','配置','资料整理','AI任务','其他'].map(k=>'<option'+(k===t.type?' selected':'')+'>'+k+'</option>').join('')+'</select></label><label>预计分钟<input type="number" data-field="estimated_minutes" min="15" max="1440" step="1" value="'+esc(t.estimated_minutes??'')+'"></label></div>'+inputField('交付内容','deliverable_expectation',t.deliverable_expectation,500,true)+inputField('验收标准','acceptance_criteria',t.acceptance_criteria,800,true)+'<div class="buttons"><button type="button" data-remove="'+i+'"'+(workPlan.tasks.length===1?' disabled':'')+'>删除</button>'+(i?'<button type="button" data-merge="'+i+'">合并到上一项</button><button type="button" data-up="'+i+'">上移</button>':'')+'</div></fieldset>').join('')+'<button type="button" data-add'+(workPlan.tasks.length===8?' disabled':'')+'>＋ 添加小任务</button><p id="plan-total" role="status"></p>';
  checkPlan();
}
function checkPlan(){
  if(!workPlan)return false;
  const times=workPlan.tasks.map(t=>t.estimated_minutes);
  const total=times.reduce((sum,n)=>sum+(Number.isFinite(n)?n:0),0);
  const timeOK=times.every(n=>Number.isInteger(n)&&n>=15&&n<=1440);
  const stated=workPlan.stated_minutes;
  const statedOK=stated===null||(Number.isInteger(stated)&&stated>=15&&stated<=11520);
  const fieldsOK=[workPlan.group,...workPlan.tasks].every(t=>['title','deliverable_expectation','acceptance_criteria'].every(k=>t[k].trim()));
  $('#plan-total').textContent='小任务合计：'+total+' 分钟（'+(total/60).toFixed(1)+' 小时）'+(!timeOK?' · 请补齐有效的小任务工时':!statedOK?' · 大任务参考时间无效':!fieldsOK?' · 请补齐名称、交付内容和验收标准':' · 小任务可独立估时，核对后可以登记');
  $('#confirm-plan').disabled=planning||busy||!timeOK||!statedOK||!fieldsOK;
  return timeOK&&statedOK&&fieldsOK;
}
function previewWork(){
  workPlan=null;planRequestId=null;
  try{const task=parseWorkText($('#work-text').value);workPlan={group:{title:task.title,deliverable_expectation:task.deliverable_expectation,acceptance_criteria:task.acceptance_criteria},tasks:[task],stated_minutes:task.estimated_minutes,warnings:[]};planRequestId=newRequestId();$('#work-validation').textContent='已识别五字段描述，可以修改后登记。';}
  catch{$('#work-validation').textContent='点击“AI 整理（DeepSeek）”，或手动创建任务。';}
  renderPlan();return workPlan;
}
$('#work-text').oninput=()=>{storage('work-source:'+user,$('#work-text').value);previewWork();};
$('#use-draft').onclick=()=>{$('#work-text').value=$('#draft').value;previewWork();tab('work');};
$('#manual-plan').onclick=()=>{if(planning||busy)return;workPlan={group:{title:'',deliverable_expectation:'',acceptance_criteria:''},tasks:[emptyTask()],stated_minutes:null,warnings:[]};planRequestId=newRequestId();renderPlan();};
$('#ai-plan').onclick=async()=>{
  const source=$('#work-text').value.trim();if(!source){notice('请先填写工作描述。',true);return;}
  if(planning||busy)return;
  planning=true;$('#ai-plan').disabled=true;$('#manual-plan').disabled=true;$('#work-text').readOnly=true;$('#work-preview').inert=true;$('#confirm-plan').disabled=true;
  $('#work-validation').textContent='正在使用 DeepSeek 整理，请稍候；不会登记或开始计时。';
  const owner=user;
  try{const result=await api('plan',{source_text:source});if(user!==owner)return;workPlan=result.plan;planRequestId=newRequestId();renderPlan();$('#work-validation').textContent='已生成 DeepSeek 草稿，请检查拆分、工时和待补充信息。';}
  catch(e){$('#work-validation').textContent=e.message;notice(e.message,true);}
  finally{planning=false;$('#ai-plan').disabled=false;$('#manual-plan').disabled=false;$('#work-text').readOnly=false;$('#work-preview').inert=false;checkPlan();}
};
$('#work-preview').oninput=e=>{
  const field=e.target.dataset.field;
  if(field){const child=e.target.closest('[data-child]');const item=child?workPlan.tasks[Number(child.dataset.child)]:workPlan.group;item[field]=field==='estimated_minutes'?(e.target.value===''?null:Number(e.target.value)):e.target.value;}
  if(e.target.hasAttribute('data-total'))workPlan.stated_minutes=e.target.value===''?null:Number(e.target.value);
  checkPlan();
};
$('#work-preview').onclick=e=>{
  const b=e.target.closest('button');if(!b||planning||busy)return;
  if(b.hasAttribute('data-add')&&workPlan.tasks.length<8)workPlan.tasks.push(emptyTask());
  if(b.hasAttribute('data-remove')&&workPlan.tasks.length>1)workPlan.tasks.splice(Number(b.dataset.remove),1);
  if(b.hasAttribute('data-up')){const i=Number(b.dataset.up);[workPlan.tasks[i-1],workPlan.tasks[i]]=[workPlan.tasks[i],workPlan.tasks[i-1]];}
  if(b.hasAttribute('data-merge')){const i=Number(b.dataset.merge),a=workPlan.tasks[i-1],t=workPlan.tasks[i];const merged={...a,title:a.title+'、'+t.title,estimated_minutes:a.estimated_minutes===null||t.estimated_minutes===null?null:a.estimated_minutes+t.estimated_minutes,deliverable_expectation:a.deliverable_expectation+'\n'+t.deliverable_expectation,acceptance_criteria:a.acceptance_criteria+'\n'+t.acceptance_criteria};if(merged.title.length>120||merged.deliverable_expectation.length>500||merged.acceptance_criteria.length>800||merged.estimated_minutes>1440){notice('合并后内容或工时过长，请先精简。',true);return;}workPlan.tasks.splice(i-1,2,merged);}
  renderPlan();
};
$('#create').onsubmit=async e=>{
  e.preventDefault();if(planning||busy||!checkPlan())return;
  busy=true;$('#confirm-plan').disabled=true;$('#work-preview').inert=true;$('#work-text').readOnly=true;$('#ai-plan').disabled=true;$('#manual-plan').disabled=true;
  try{const result=await api('create-plan',{plan:workPlan,source_text:$('#work-text').value,request_id:planRequestId});notice(result.message);workPlan=null;planRequestId=null;$('#work-text').value='';storage('work-source:'+user,'');renderPlan();await refresh();showView('my-tasks',true);}
  catch(e){notice(e.message,true);}
  finally{busy=false;$('#work-preview').inert=false;$('#work-text').readOnly=false;$('#ai-plan').disabled=false;$('#manual-plan').disabled=false;checkPlan();}
};
$('#heartbeat').onsubmit=async e=>{
  e.preventDefault();if(busy)return;
  const form=e.target, args=Object.fromEntries(new FormData(form));
  if(!args.task_id){notice('请先开始一个任务，再提交进展。',true);return;}
  busy=true;
  const controls=[...form.querySelectorAll('button,input,textarea,select')];
  controls.forEach(control=>control.disabled=true);
  $('#heartbeat-image-status').textContent='正在提交汇报和图片，请稍候…';
  try{
    $('#heartbeat-image-status').textContent=heartbeatImages.length?'正在压缩图片，请稍候…':'正在提交汇报，请稍候…';
    const archiveDrafts=typeof heartbeatArchives==='undefined'?[]:heartbeatArchives;
    const prepared=await Promise.all(heartbeatImages.map(({file})=>compressHeartbeatImage(file)));
    const archives=await Promise.all(archiveDrafts.map(({file})=>readHeartbeatArchive(file)));
    args.images=prepared.map(image=>image.payload);
    args.attachments=archives.map(archive=>archive.payload);
    const compressed=prepared.filter(image=>image.compressed).length;
    if(compressed)$('#heartbeat-image-status').textContent='已压缩 '+compressed+' 张，正在上传…';
    const result=await api('heartbeat',args);
    form.reset();clearHeartbeatImages();notice(result.message);
    $('#heartbeat-image-status').textContent='汇报已保存。';
    try{await refresh();}catch{notice('汇报已保存，但列表刷新失败，请刷新页面查看。',true);}
  }catch(error){$('#heartbeat-image-status').textContent=error.message+' 已保留文字和图片，可重试。';notice(error.message,true);}
  finally{busy=false;controls.forEach(control=>control.disabled=false);}
};
function readHeartbeatImage(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(Error('无法读取图片：'+file.name));
    reader.onabort=()=>reject(Error('图片读取已取消。'));
    reader.onload=()=>resolve({name:file.name,data:String(reader.result).split(',')[1],contentType:file.type||'image/png'});
    reader.readAsDataURL(file);
  });
}
function compressHeartbeatImage(file){
  // Keep the non-browser test/runtime fallback usable; production pages have Canvas and Image.
  if(typeof document==='undefined'||typeof Image==='undefined')return readHeartbeatImage(file).then(payload=>({payload,compressed:false}));
  return new Promise((resolve,reject)=>{
    const originalMime=file.type||(/\.jpe?g$/i.test(file.name||'')?'image/jpeg':/\.webp$/i.test(file.name||'')?'image/webp':'image/png');
    const reader=new FileReader();
    reader.onerror=()=>reject(Error('无法读取图片：'+file.name));
    reader.onabort=()=>reject(Error('图片读取已取消。'));
    reader.onload=()=>{
      const image=new Image();
      image.onerror=()=>reject(Error('图片无法解码：'+file.name));
      image.onload=()=>{
        try{
          const maxEdge=1600, scale=Math.min(1,maxEdge/Math.max(image.naturalWidth||image.width,image.naturalHeight||image.height));
          const canvas=document.createElement('canvas');
          canvas.width=Math.max(1,Math.round((image.naturalWidth||image.width)*scale));
          canvas.height=Math.max(1,Math.round((image.naturalHeight||image.height)*scale));
          const context=canvas.getContext('2d');
          if(!context)throw Error('当前浏览器不支持图片压缩。');
          context.drawImage(image,0,0,canvas.width,canvas.height);
          let dataUrl=canvas.toDataURL('image/webp',0.82), mime='image/webp';
          if(!dataUrl.startsWith('data:image/webp')){
            // JPEG is a broadly supported fallback. The white background avoids black transparent pixels.
            context.save();context.globalCompositeOperation='destination-over';context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.restore();
            dataUrl=canvas.toDataURL('image/jpeg',0.82);mime='image/jpeg';
          }
          const original=String(reader.result), compressedBytes=Math.max(0,Math.round((dataUrl.length-dataUrl.indexOf(',')-1)*0.75));
          const originalBytes=Number(file.size)||Math.round((original.length-original.indexOf(',')-1)*0.75);
          const useCompressed=compressedBytes>0&&compressedBytes<originalBytes;
          const selected=useCompressed?dataUrl:original;
          const selectedName=useCompressed?file.name.replace(/\.[^.]+$/,'')+(mime==='image/webp'?'.webp':'.jpg'):file.name;
          resolve({compressed:useCompressed,payload:{name:selectedName,data:selected.split(',')[1],contentType:useCompressed?mime:originalMime}});
        }catch(error){reject(error);}
      };
      image.src=String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
function clearHeartbeatImages(){
  heartbeatImages.forEach(image=>URL.revokeObjectURL(image.url));heartbeatImages=[];
  $('#heartbeat-images').value='';renderHeartbeatImages();
  if(typeof clearHeartbeatArchives==='function')clearHeartbeatArchives();
}
function renderHeartbeatImages(){
  $('#heartbeat-image-previews').innerHTML=heartbeatImages.map((image,index)=>'<figure><img src="'+esc(image.url)+'" alt="'+esc(image.file.name)+'"><figcaption>'+esc(image.file.name)+'</figcaption><button type="button" data-remove-image="'+index+'" aria-label="移除 '+esc(image.file.name)+'">移除</button></figure>').join('');
  const total=heartbeatImages.reduce((sum,image)=>sum+image.file.size,0);
  $('#heartbeat-image-status').textContent=heartbeatImages.length?'已选 '+heartbeatImages.length+' / 6 张 · '+(total/1024/1024).toFixed(1)+' / 12 MB · 提交时自动压缩':'';
}
function addHeartbeatImages(files){
  if(busy)return;
  let error='';
  if(files.length+heartbeatImages.length>6)error='每次汇报最多上传 6 张图片。';
  else if(files.some(file=>!['image/png','image/jpeg','image/webp'].includes(file.type)))error='仅支持 PNG、JPG 和 WebP 图片。';
  else if(files.some(file=>!file.size||file.size>4*1024*1024))error='图片不能为空，且单张不能超过 4 MB。';
  else if([...files,...heartbeatImages.map(image=>image.file)].reduce((sum,file)=>sum+file.size,0)>12*1024*1024)error='每次汇报的图片合计不能超过 12 MB。';
  if(error){$('#heartbeat-image-status').textContent=error;return;}
  heartbeatImages.push(...files.map(file=>({file,url:URL.createObjectURL(file)})));renderHeartbeatImages();
}
$('#heartbeat-images').onchange=e=>{
  const files=[...e.target.files];e.target.value='';addHeartbeatImages(files);
};
const handleHeartbeatPaste=e=>{
  const files=[...e.clipboardData.items]
    .filter(item=>item.kind==='file'&&item.type.startsWith('image/'))
    .map(item=>item.getAsFile())
    .filter(Boolean);
  if(!files.length)return;
  e.preventDefault();
  addHeartbeatImages(files);
};
const heartbeatDetail=$('#heartbeat textarea[name="detail"]');
if(typeof heartbeatDetail.addEventListener==='function')heartbeatDetail.addEventListener('paste',handleHeartbeatPaste);
else heartbeatDetail.onpaste=handleHeartbeatPaste;
$('#heartbeat-image-help').textContent+=' 也可以直接在“简短说明”里粘贴图片。';
$('#heartbeat-image-previews').onclick=e=>{
  const button=e.target.closest('[data-remove-image]');if(!button||busy)return;
  const [image]=heartbeatImages.splice(Number(button.dataset.removeImage),1);
  if(image)URL.revokeObjectURL(image.url);renderHeartbeatImages();
};
function readHeartbeatArchive(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(Error('无法读取压缩包：'+file.name));
    reader.onabort=()=>reject(Error('压缩包读取已取消。'));
    reader.onload=()=>resolve({payload:{name:file.name,data:String(reader.result).split(',')[1]}});
    reader.readAsDataURL(file);
  });
}
function clearHeartbeatArchives(){
  if(typeof heartbeatArchives==='undefined')return;
  heartbeatArchives.forEach(archive=>URL.revokeObjectURL(archive.url));heartbeatArchives=[];
  $('#heartbeat-archives').value='';renderHeartbeatArchives();
}
function renderHeartbeatArchives(){
  if(typeof heartbeatArchives==='undefined')return;
  $('#heartbeat-archive-previews').innerHTML=heartbeatArchives.map((archive,index)=>'<div class="archive-preview"><span aria-hidden="true">▣</span><strong>'+esc(archive.file.name)+'</strong><small>'+(archive.file.size/1024/1024).toFixed(1)+' MB</small><button type="button" data-remove-archive="'+index+'" aria-label="移除 '+esc(archive.file.name)+'">移除</button></div>').join('');
  const total=heartbeatArchives.reduce((sum,archive)=>sum+archive.file.size,0);
  $('#heartbeat-archive-status').textContent=heartbeatArchives.length?'已选 '+heartbeatArchives.length+' / 2 个压缩包 · '+(total/1024/1024).toFixed(1)+' / 20 MB':'';
}
$('#heartbeat-archives').onchange=e=>{
  if(busy)return;
  const files=[...e.target.files];e.target.value='';
  if(files.length+(typeof heartbeatArchives==='undefined'?0:heartbeatArchives.length)>2){$('#heartbeat-archive-status').textContent='每次汇报最多上传 2 个压缩包。';return;}
  const validExtension=file=>/\.(zip|rar|7z)$/i.test(file.name||'');
  let error='';
  if(files.some(file=>!validExtension(file)&&!['application/zip','application/x-rar-compressed','application/x-7z-compressed','application/x-7z-compressed'].includes(file.type)))error='仅支持 ZIP、RAR 和 7Z 压缩包。';
  else if(files.some(file=>!file.size||file.size>20*1024*1024))error='单个压缩包不能超过 20 MB。';
  else if([...files,...(typeof heartbeatArchives==='undefined'?[]:heartbeatArchives.map(archive=>archive.file))].reduce((sum,file)=>sum+file.size,0)>20*1024*1024)error='每次汇报的压缩包合计不能超过 20 MB。';
  if(error){$('#heartbeat-archive-status').textContent=error;return;}
  heartbeatArchives.push(...files.map(file=>({file,url:URL.createObjectURL(file)})));renderHeartbeatArchives();
};
$('#heartbeat-archive-previews').onclick=e=>{
  const button=e.target.closest('[data-remove-archive]');if(!button||busy||typeof heartbeatArchives==='undefined')return;
  const [archive]=heartbeatArchives.splice(Number(button.dataset.removeArchive),1);
  if(archive)URL.revokeObjectURL(archive.url);renderHeartbeatArchives();
};
function readTaskFile(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(Error('无法读取文件：'+file.name));
    reader.onabort=()=>reject(Error('文件读取已取消。'));
    reader.onload=()=>resolve({name:file.name,data:typeof reader.result==='string'?reader.result.split(',')[1]:'',contentType:file.type||'application/octet-stream'});
    reader.readAsDataURL(file);
  });
}
function renderTaskFiles(){
  $('#action-file-previews').innerHTML=actionFiles.map((item,index)=>'<div class="archive-preview"><span aria-hidden="true">▣</span><strong>'+esc(item.file.name||'附件')+'</strong><small>'+formatFileSize(item.file.size)+'</small><button type="button" data-remove-task-file="'+index+'" aria-label="移除 '+esc(item.file.name||'附件')+'">移除</button></div>').join('');
  const total=actionFiles.reduce((sum,item)=>sum+item.file.size,0);
  $('#action-file-status').textContent=actionFiles.length?'已选 '+actionFiles.length+' / 6 个文件 · '+(total/1024/1024).toFixed(1)+' / 40 MB':'';
}
function formatFileSize(size){return size<1024*1024?Math.max(1,Math.round(size/1024))+' KB':(size/1024/1024).toFixed(1)+' MB';}
function clearActionImages(){actionImages.forEach(image=>URL.revokeObjectURL(image.url));actionImages=[];$('#action-images').value='';renderActionImages();}
function renderActionImages(){
  $('#action-image-previews').innerHTML=actionImages.map((image,index)=>'<figure><img src="'+esc(image.url)+'" alt="'+esc(image.file.name)+'"><figcaption>'+esc(image.file.name)+'</figcaption><button type="button" data-remove-action-image="'+index+'" aria-label="移除 '+esc(image.file.name)+'">移除</button></figure>').join('');
  const total=actionImages.reduce((sum,image)=>sum+image.file.size,0);
  $('#action-image-status').textContent=actionImages.length?'已选 '+actionImages.length+' / 6 张 · '+(total/1024/1024).toFixed(1)+' / 12 MB · 提交时自动压缩':'';
}
function addActionImages(files){
  if(busy)return;
  let error='';
  const totalImages=actionImages.reduce((sum,image)=>sum+image.file.size,0)+files.reduce((sum,file)=>sum+file.size,0);
  const totalFiles=totalImages+actionFiles.reduce((sum,item)=>sum+item.file.size,0);
  if(files.length+actionImages.length+actionFiles.length>6)error='截图和附件合计最多上传 6 个。';
  else if(files.some(file=>!['image/png','image/jpeg','image/webp'].includes(file.type)&&!/\.(png|jpe?g|webp)$/i.test(file.name||'')))error='截图仅支持 PNG、JPG 和 WebP。';
  else if(files.some(file=>!file.size||file.size>4*1024*1024))error='单张截图不能超过 4 MB。';
  else if(totalImages>12*1024*1024)error='截图合计不能超过 12 MB。';
  else if(totalFiles>40*1024*1024)error='截图和附件合计不能超过 40 MB。';
  if(error){$('#action-image-status').textContent=error;return;}
  actionImages.push(...files.map(file=>({file,url:URL.createObjectURL(file)})));renderActionImages();
}
$('#action-images').onchange=e=>{const files=[...e.target.files];e.target.value='';addActionImages(files);};
$('#action-image-previews').onclick=e=>{const button=e.target.closest('[data-remove-action-image]');if(!button||busy)return;const [image]=actionImages.splice(Number(button.dataset.removeActionImage),1);if(image)URL.revokeObjectURL(image.url);renderActionImages();};
function addTaskFiles(files){
  if(busy)return;
  let error='';
  if(files.length+actionFiles.length+actionImages.length>6)error='截图和附件合计最多上传 6 个。';
  else if(files.some(file=>!file.size||file.size>20*1024*1024))error='文件不能为空，且单个不能超过 20 MB。';
  else if([...files,...actionFiles.map(item=>item.file),...actionImages.map(image=>image.file)].reduce((sum,file)=>sum+file.size,0)>40*1024*1024)error='截图和附件合计不能超过 40 MB。';
  if(error){$('#action-file-status').textContent=error;return;}
  actionFiles.push(...files.map(file=>({file})));renderTaskFiles();
}
$('#action-files').onchange=e=>{const files=[...e.target.files];e.target.value='';addTaskFiles(files);};
$('#action-file-previews').onclick=e=>{const button=e.target.closest('[data-remove-task-file]');if(!button||busy)return;actionFiles.splice(Number(button.dataset.removeTaskFile),1);renderTaskFiles();};
$('#tasks').onclick=async e=>{
  if(planning||busy)return;
  const append=e.target.closest('button[data-append-group]');
  if(append){
    appendGroupId=append.dataset.appendGroup;
    appendRequestId=newRequestId();
    const group=groupCache.find(item=>item.id===appendGroupId);
    $('#append-title').textContent='补充小任务'+(group?' · '+group.title:'');
    $('#append-form').reset();
    $('#append-adjustments').innerHTML=group&&group.tasks.some(t=>!['已完成','待验收'].includes(t.status))?'<p class="hint">如需修正尚未提交的预计时间，可一并调整：</p>'+group.tasks.map(t=>{const locked=['已完成','待验收'].includes(t.status);return '<label class="append-adjustment"><span>'+esc(t.title)+' · '+esc(t.status)+(locked?'（历史锁定）':'')+'</span><input type="number" data-estimate-task="'+esc(t.id)+'" data-original-estimate="'+esc(t.estimated_minutes)+'" value="'+esc(t.estimated_minutes)+'" min="15" max="1440" step="1" required'+(locked?' disabled':'')+'></label>';}).join(''):'';
    $('#append-dialog').showModal();
    return;
  }
  const b=e.target.closest('button[data-action]');
  if(!b)return;
  selected={action:b.dataset.action,id:b.dataset.id};
  if(selected.action==='work_withdraw_submission'&&!window.confirm('取消待验收后需要重新继续任务并提交，确定撤回吗？'))return;
  if(['work_finish_task','work_block_task'].includes(selected.action)){$('#action-title').textContent=selected.action==='work_finish_task'?'完成说明':'阻塞原因';$('#ai-score-fields').hidden=selected.action!=='work_finish_task';$('#action-form').reset();clearActionImages();actionFiles=[];renderTaskFiles();$('#action-dialog').showModal();}
  else await run(selected.action,{task_id:selected.id});
};
$('#cancel').onclick=()=>{clearActionImages();actionFiles=[];renderTaskFiles();$('#action-dialog').close();};
$('#action-form').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));const note=$('#action-file-status');try{note.textContent=actionImages.length||actionFiles.length?'正在读取截图和附件，请稍候…':'';const prepared=await Promise.all(actionImages.map(({file})=>compressHeartbeatImage(file)));const files=await Promise.all(actionFiles.map(item=>readTaskFile(item.file)));const attachments=[...prepared.map(image=>image.payload),...files];const args={task_id:selected.id,attachments,...(selected.action==='work_finish_task'?{summary:d.detail,...(d.employee_ai_points!==''?{employee_ai_points:Number(d.employee_ai_points),employee_ai_reason:d.employee_ai_reason}:{})}:{reason:d.detail})};if(await run(selected.action,args)){clearActionImages();actionFiles=[];renderTaskFiles();$('#action-dialog').close();}}catch(error){note.textContent=error.message;notice(error.message,true);}};
$('#append-cancel').onclick=()=>{appendGroupId=null;appendRequestId=null;$('#append-dialog').close();};
$('#append-form').onsubmit=async e=>{
  e.preventDefault();
  if(!appendGroupId||busy)return;
  const d=Object.fromEntries(new FormData(e.target));
  const estimate_updates=[...document.querySelectorAll('[data-estimate-task]:not(:disabled)')].filter(input=>input.value!==input.dataset.originalEstimate).map(input=>({task_id:input.dataset.estimateTask,estimated_minutes:Number(input.value)})).filter(update=>Number.isInteger(update.estimated_minutes));
  const args={group_id:appendGroupId,request_id:appendRequestId,reason:d.reason,estimate_updates,tasks:[{title:d.title,type:d.type,estimated_minutes:Number(d.estimated_minutes),deliverable_expectation:d.deliverable_expectation,acceptance_criteria:d.acceptance_criteria}]};
  busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{const result=await api('append-plan',args);notice(result.message);appendGroupId=null;appendRequestId=null;$('#append-dialog').close();await refresh();}
  catch(err){notice(err.message,true);}
  finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
};
function stopAudio(){playing.forEach(o=>{try{o.stop();}catch{}});playing=[];$('#stop-sound').hidden=true;}
function chime(kind){
  if(!audio||audio.state!=='running')return;
  stopAudio();const duration=kind==='rest'?15:30;const start=audio.currentTime;const notes=kind==='rest'?[880,1174]:[523,659,784,659,587,698,880,698];
  for(let s=0;s<duration;s+=0.65){const o=audio.createOscillator(),g=audio.createGain();o.type=kind==='rest'?'sine':'triangle';o.frequency.value=notes[Math.floor(s/.65)%notes.length];g.gain.setValueAtTime(0,start+s);g.gain.linearRampToValueAtTime(.1,start+s+.02);g.gain.exponentialRampToValueAtTime(.0001,start+s+.45);o.connect(g);g.connect(audio.destination);o.start(start+s);o.stop(start+s+.5);playing.push(o);}
  $('#stop-sound').hidden=false;
}
$('#stop-sound').onclick=stopAudio;
$('#sound').onclick=async()=>{try{audio??=new AudioContext();await audio.resume();sound=audio.state==='running';$('#sound').textContent=sound?'声音已开启 · 点击检查':'重试开启声音';if('Notification'in window&&Notification.permission==='default')await Notification.requestPermission();$('#sound-note').textContent='休息铃声 15 秒 · 回到工作音乐 30 秒'+(('Notification'in window&&Notification.permission==='granted')?' · 桌面通知已开启':' · 桌面通知未开启');reworks();}catch{notice('浏览器未能启用声音，请检查站点声音权限。',true);}};
function tick(){
  const now=new Date(Date.now()+offset),parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now).split(':').map(Number),sec=parts[0]*3600+parts[1]*60+parts[2];
  const start=sec>=34200&&sec<43200?34200:sec>=50400&&sec<66600?50400:null;
  const within=start===null?0:(sec-start)%1800, phase=start===null?'off':within<1500?'work':'rest',remaining=phase==='work'?1500-within:1800-within;
  $('#phase').textContent=phase==='work'?'专注中':phase==='rest'?'休息一下吧':sec<34200?'09:30 开始工作':sec<50400?'午休中 · 14:00 继续':'今天辛苦了';
  $('#countdown').textContent=phase==='off'?'--:--':String(Math.floor(remaining/60)).padStart(2,'0')+':'+String(remaining%60).padStart(2,'0');
  const key=start+':'+Math.floor((sec-(start||0))/1800)+':'+phase;
  if(lastPhase&&lastPhase!==key&&user&&phase!=='off'){
    chime(phase);
    const message=phase==='rest'?'该休息 5 分钟了':'休息结束，开始下一段工作';notice(message);
    document.title=message+' · 员工工作台';
    if('Notification'in window&&Notification.permission==='granted'){try{const n=new Notification(message,{tag:'team-pomodoro'});n.onclick=()=>{window.focus();n.close();};}catch{}}
  }
  lastPhase=key;
}
refresh().catch(e=>{if(!e.message.includes('姓名'))notice(e.message,true);});
setInterval(()=>{if(user&&!busy)refresh().catch(e=>notice(e.message,true));},30000);
setInterval(tick,1000);tick();
document.addEventListener('visibilitychange',()=>{if(!document.hidden){tick();if(user)refresh().catch(e=>notice(e.message,true));}});
