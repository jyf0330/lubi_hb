const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('server/static/employee.js','utf8');
const nodes=new Map(), revoked=[];
const $=key=>{if(!nodes.has(key))nodes.set(key,{value:'',innerHTML:'',textContent:'',disabled:false});return nodes.get(key);};
const file=(name='截图.png',size=1024,type='image/png')=>({name,size,type});
let fail=false,refreshFail=false,calls=0,request, resets=0;
const ctx=vm.createContext({$,busy:false,heartbeatImages:[],Promise,notice:()=>{},
  esc:v=>String(v).replaceAll('<','&lt;').replaceAll('"','&quot;'),
  URL:{createObjectURL:()=>`blob:preview-${Math.random()}`,revokeObjectURL:url=>revoked.push(url)},
  FileReader:class{readAsDataURL(){this.result='data:image/png;base64,aGVsbG8=';this.onload();}},
  FormData:class{constructor(){return [['task_id','task-1'],['detail','进展说明'],['status','正常推进']];}},
  api:async(path,args)=>{calls++;request={path,args};if(fail)throw Error('连接失败');return {message:'已保存'};},
  refresh:async()=>{if(refreshFail)throw Error('刷新失败');},
});
const start=source.indexOf("$('#heartbeat').onsubmit"),end=source.indexOf("$('#tasks').onclick",start);
assert.ok(start>0&&end>start);
vm.runInContext(source.slice(start,end),ctx);
const pick=files=>$('#heartbeat-images').onchange({target:{files,value:''}});
const count=()=>vm.runInContext('heartbeatImages.length',ctx);
const form={querySelectorAll:()=>[$('#submit')],reset:()=>resets++};
const submit=()=>$('#heartbeat').onsubmit({preventDefault(){},target:form});
(async()=>{
  pick([file('<unsafe>.png'),file('two.png')]);assert.equal(count(),2);
  assert.match($('#heartbeat-image-previews').innerHTML,/&lt;unsafe>/);
  pick([file('bad.svg',12,'image/svg+xml')]);assert.equal(count(),2);assert.match($('#heartbeat-image-status').textContent,/仅支持/);
  pick([file('large.png',4*1024*1024+1)]);assert.equal(count(),2);
  pick(Array.from({length:5},()=>file()));assert.equal(count(),2);
  $('#heartbeat-image-previews').onclick({target:{closest:()=>({dataset:{removeImage:'1'}})}});
  assert.equal(count(),1);assert.equal(revoked.length,1);
  fail=true;await submit();assert.equal(count(),1);assert.equal(resets,0);assert.equal($('#submit').disabled,false);
  assert.match($('#heartbeat-image-status').textContent,/已保留/);
  fail=false;refreshFail=true;await submit();assert.equal(count(),0);assert.equal(resets,1);
  assert.equal(request.path,'heartbeat');assert.equal(request.args.images[0].name,'<unsafe>.png');
  assert.match($('#heartbeat-image-status').textContent,/已保存/);
  vm.runInContext('busy=true',ctx);await submit();assert.equal(calls,2);vm.runInContext('busy=false',ctx);
  pick(Array.from({length:3},()=>file('large.png',4*1024*1024)));assert.equal(count(),3);
  pick([file()]);assert.equal(count(),3);assert.match($('#heartbeat-image-status').textContent,/合计/);
  vm.runInContext('clearHeartbeatImages()',ctx);await submit();assert.equal(request.args.images.length,0);
  const gallery=vm.runInNewContext(fs.readFileSync('server/static/report-images.js','utf8')+';reportImageGallery',{URL});
  const html=gallery([{id:'image-id',name:'<img onerror="oops">'}],new URL('https://example.test/team-board/api/'));
  assert.match(html,/https:\/\/example.test\/team-board\/api\/report-images\/image-id/);
  assert.match(html,/download=1/);
  assert.match(html,/下载图片/);
  assert.match(html,/&lt;img/);assert.ok(!html.includes('onerror="oops"'));
  const helpers=vm.runInNewContext(fs.readFileSync('server/static/report-images.js','utf8')+';({taskAttachmentGallery,reportImagePreviewStrip})',{URL});
  const taskHtml=helpers.taskAttachmentGallery([{id:'task-image',name:'截图.webp',content_type:'image/webp',size:1024},{id:'task-file',name:'交付.zip',content_type:'application/zip',size:1024}]);
  assert.match(taskHtml,/task-files\/task-file/);
  assert.match(taskHtml,/task-image/);
  assert.match(taskHtml,/download=1/);
  console.log('REPORT_IMAGES_UI_OK');
})().catch(error=>{console.error(error);process.exitCode=1;});
