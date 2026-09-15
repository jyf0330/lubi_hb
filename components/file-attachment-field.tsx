'use client';

import * as React from 'react';
import { FileUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

const MAX_FILES = 6;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export type FileAttachmentDraft = {
  id: string;
  file: File;
};

export type FilePayload = {
  name: string;
  data: string;
  contentType: string;
};

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`无法读取文件：${file.name}`));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export async function encodeFileDrafts(
  drafts: FileAttachmentDraft[],
): Promise<FilePayload[]> {
  return Promise.all(
    drafts.map(async ({ file }) => ({
      name: file.name || '附件',
      data: (await readAsDataUrl(file)).split(',')[1] || '',
      contentType: file.type || 'application/octet-stream',
    })),
  );
}

export function FileAttachmentField({
  files,
  onFilesChange,
}: {
  files: FileAttachmentDraft[];
  onFilesChange: (files: FileAttachmentDraft[]) => void;
}) {
  const inputId = React.useId();
  const [error, setError] = React.useState('');

  function addFiles(nextFiles: File[]) {
    setError('');
    if (files.length + nextFiles.length > MAX_FILES) {
      setError(`最多添加 ${MAX_FILES} 个文件。`);
      return;
    }
    if (nextFiles.some((file) => !file.size || file.size > MAX_FILE_BYTES)) {
      setError('文件不能为空，且单个不能超过 20 MB。');
      return;
    }
    const totalBytes = [
      ...files.map(({ file }) => file.size),
      ...nextFiles.map((file) => file.size),
    ].reduce((sum, size) => sum + size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      setError('文件合计不能超过 40 MB。');
      return;
    }
    onFilesChange(
      files.concat(
        nextFiles.map((file, index) => ({
          id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
          file,
        })),
      ),
    );
  }

  function removeFile(id: string) {
    onFilesChange(files.filter((item) => item.id !== id));
  }

  return (
    <div className="file-attachment-field">
      <div className="file-attachment-toolbar">
        <span>
          {files.length
            ? `已添加 ${files.length} 个文件`
            : '可提交压缩包、文档、表格等交付文件'}
        </span>
        <label className="file-attachment-button" htmlFor={inputId}>
          <FileUp size={15} />
          添加文件
        </label>
        <input
          id={inputId}
          type="file"
          accept="*/*"
          multiple
          hidden
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>
      {files.length > 0 && (
        <div className="file-attachment-list" aria-label="待提交的文件">
          {files.map(({ id, file }) => (
            <div className="file-attachment-item" key={id}>
              <FileUp size={15} aria-hidden="true" />
              <span title={file.name}>{file.name || '附件'}</span>
              <small>{formatFileSize(file.size)}</small>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`移除 ${file.name || '附件'}`}
                onClick={() => removeFile(id)}
              >
                <X size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="file-attachment-error">{error}</p>}
    </div>
  );
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
