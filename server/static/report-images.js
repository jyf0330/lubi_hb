/* Shared by employee history and the owner's progress dashboard. */
function reportImageGallery(images, apiRoot) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return '<div class="report-images">' + (images || []).map(image => {
    const url = new URL('report-images/' + encodeURIComponent(image.id), apiRoot).href;
    return '<a href="'+escape(url)+'" target="_blank" rel="noopener" title="查看原图：'+escape(image.name)+'"><img src="'+escape(url)+'" alt="'+escape(image.name)+'" loading="lazy"><span>'+escape(image.name)+'</span></a>';
  }).join('') + '</div>';
}

function reportFileGallery(files, apiRoot) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return '<div class="report-files">' + (files || []).map(file => {
    const url = new URL('report-files/' + encodeURIComponent(file.id), apiRoot).href;
    const size = file.size ? (file.size / 1024 / 1024).toFixed(1) + ' MB' : '';
    return '<a href="'+escape(url)+'" download title="下载附件：'+escape(file.name)+'"><span aria-hidden="true">▣</span><strong>'+escape(file.name)+'</strong><small>'+escape(size)+'</small></a>';
  }).join('') + '</div>';
}

function taskFileGallery(files) {
  if (!files || !files.length) return '';
  return '<div class="task-files">' + files.map(file => {
    const url = '/api/task-files/' + encodeURIComponent(file.id);
    const size = file.size ? (file.size / 1024 / 1024).toFixed(1) + ' MB' : '';
    return '<a href="'+escapeTaskFile(url)+'" download title="下载附件：'+escapeTaskFile(file.name)+'"><span aria-hidden="true">▣</span><strong>'+escapeTaskFile(file.name)+'</strong><small>'+escapeTaskFile(size)+'</small></a>';
  }).join('') + '</div>';
}

function escapeTaskFile(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
