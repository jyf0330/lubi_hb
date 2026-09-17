/* Shared by employee history, task cards, and the owner's progress dashboard. */
function escapeGallery(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function galleryDownloadUrl(url) {
  return url + (url.includes('?') ? '&' : '?') + 'download=1';
}

function reportImageUrl(image, apiRoot, download = false) {
  const url = new URL('report-images/' + encodeURIComponent(image.id), apiRoot).href;
  return download ? galleryDownloadUrl(url) : url;
}

// oxlint-disable-next-line no-unused-vars -- consumed by employee.js and app.js.
function reportImageGallery(images, apiRoot) {
  return '<div class="report-images" aria-label="图片附件">' + (images || []).map(image => {
    const url = reportImageUrl(image, apiRoot);
    const downloadUrl = reportImageUrl(image, apiRoot, true);
    return '<figure class="report-image-card"><a class="report-image-preview" href="'+escapeGallery(url)+'" target="_blank" rel="noopener" title="查看原图：'+escapeGallery(image.name)+'"><img src="'+escapeGallery(url)+'" alt="'+escapeGallery(image.name)+'" loading="lazy"><span>'+escapeGallery(image.name)+'</span></a><a class="report-image-download" href="'+escapeGallery(downloadUrl)+'" download title="下载图片：'+escapeGallery(image.name)+'">下载图片</a></figure>';
  }).join('') + '</div>';
}

// oxlint-disable-next-line no-unused-vars -- consumed by app.js.
function reportImagePreviewStrip(images, apiRoot) {
  if (!images || !images.length) return '';
  return '<span class="report-image-strip" aria-label="最近图片">' + images.slice(0, 3).map(image => {
    const url = reportImageUrl(image, apiRoot);
    return '<img src="'+escapeGallery(url)+'" alt="" loading="lazy">';
  }).join('') + (images.length > 3 ? '<span class="report-image-more">+'+(images.length - 3)+'</span>' : '') + '</span>';
}

// oxlint-disable-next-line no-unused-vars -- consumed by employee.js.
function reportFileGallery(files, apiRoot) {
  return '<div class="report-files">' + (files || []).map(file => {
    const url = new URL('report-files/' + encodeURIComponent(file.id), apiRoot).href;
    const size = file.size ? (file.size / 1024 / 1024).toFixed(1) + ' MB' : '';
    return '<a href="'+escapeGallery(url)+'" download title="下载附件：'+escapeGallery(file.name)+'"><span aria-hidden="true">▣</span><strong>'+escapeGallery(file.name)+'</strong><small>'+escapeGallery(size)+'</small></a>';
  }).join('') + '</div>';
}

function taskImageGallery(files, apiRoot) {
  const images = (files || []).filter(file => String(file.content_type || '').startsWith('image/'));
  if (!images.length) return '';
  return '<div class="report-images task-images" aria-label="任务图片">' + images.map(image => {
    const url = new URL('task-files/' + encodeURIComponent(image.id), apiRoot).href;
    const downloadUrl = galleryDownloadUrl(url);
    return '<figure class="report-image-card"><a class="report-image-preview" href="'+escapeGallery(url)+'" target="_blank" rel="noopener" title="查看图片：'+escapeGallery(image.name)+'"><img src="'+escapeGallery(url)+'" alt="'+escapeGallery(image.name)+'" loading="lazy"><span>'+escapeGallery(image.name)+'</span></a><a class="report-image-download" href="'+escapeGallery(downloadUrl)+'" download title="下载图片：'+escapeGallery(image.name)+'">下载图片</a></figure>';
  }).join('') + '</div>';
}

function taskFileGallery(files, apiRoot) {
  const documents = (files || []).filter(file => !String(file.content_type || '').startsWith('image/'));
  if (!documents.length) return '';
  return '<div class="task-files">' + documents.map(file => {
    const url = new URL('task-files/' + encodeURIComponent(file.id), apiRoot).href;
    const size = file.size ? (file.size / 1024 / 1024).toFixed(1) + ' MB' : '';
    return '<a href="'+escapeGallery(url)+'" download title="下载附件：'+escapeGallery(file.name)+'"><span aria-hidden="true">▣</span><strong>'+escapeGallery(file.name)+'</strong><small>'+escapeGallery(size)+'</small></a>';
  }).join('') + '</div>';
}

// oxlint-disable-next-line no-unused-vars -- consumed by employee.js and app.js.
function taskAttachmentGallery(files, apiRoot) {
  return taskImageGallery(files, apiRoot) + taskFileGallery(files, apiRoot);
}
