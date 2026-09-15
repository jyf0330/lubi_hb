'use client';

import * as React from 'react';
import { ImagePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export type PastedImageDraft = {
  id: string;
  file: File;
  previewUrl: string;
};

export type ImagePayload = {
  name: string;
  data: string;
  contentType: string;
};

function fileName(file: File, index: number) {
  return file.name || `粘贴图片-${index + 1}.png`;
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`无法读取图片：${file.name}`));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('图片无法解码，请换一张图片。'));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

async function compressImage(file: File) {
  const original = await readAsDataUrl(file);
  const image = await loadImage(original);
  const maxEdge = 1600;
  const scale = Math.min(
    1,
    maxEdge / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height),
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const context = canvas.getContext('2d');
  if (!context) return { dataUrl: original, contentType: file.type };

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let dataUrl = canvas.toDataURL('image/webp', 0.82);
  let contentType = 'image/webp';
  if (!dataUrl.startsWith('data:image/webp')) {
    context.save();
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
    dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    contentType = 'image/jpeg';
  }

  const originalBytes = Math.max(0, Math.round((original.length - original.indexOf(',') - 1) * 0.75));
  const compressedBytes = Math.max(
    0,
    Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75),
  );
  return compressedBytes > 0 && compressedBytes < originalBytes
    ? { dataUrl, contentType }
    : { dataUrl: original, contentType: file.type };
}

export async function encodeImageDrafts(
  drafts: PastedImageDraft[],
): Promise<ImagePayload[]> {
  return Promise.all(
    drafts.map(async (draft, index) => {
      const compressed = await compressImage(draft.file);
      return {
        name: fileName(draft.file, index),
        data: compressed.dataUrl.split(',')[1] || '',
        contentType: compressed.contentType,
      };
    }),
  );
}

export function releaseImageDrafts(drafts: PastedImageDraft[]) {
  drafts.forEach((draft) => URL.revokeObjectURL(draft.previewUrl));
}

export function PasteImageField({
  images,
  onImagesChange,
  ...textareaProps
}: React.ComponentProps<typeof Textarea> & {
  images: PastedImageDraft[];
  onImagesChange: (images: PastedImageDraft[]) => void;
}) {
  const inputId = React.useId();
  const [error, setError] = React.useState('');

  function addFiles(files: File[]) {
    setError('');
    const imageFiles = files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
    if (imageFiles.length !== files.length) {
      setError('仅支持 PNG、JPG 和 WebP 图片。');
      return;
    }
    if (images.length + imageFiles.length > MAX_IMAGES) {
      setError(`最多添加 ${MAX_IMAGES} 张图片。`);
      return;
    }
    if (imageFiles.some((file) => !file.size || file.size > MAX_IMAGE_BYTES)) {
      setError('图片不能为空，且单张不能超过 4 MB。');
      return;
    }
    const totalBytes = [...images.map((image) => image.file.size), ...imageFiles.map((file) => file.size)].reduce(
      (sum, size) => sum + size,
      0,
    );
    if (totalBytes > MAX_TOTAL_BYTES) {
      setError('图片合计不能超过 12 MB。');
      return;
    }
    onImagesChange(
      images.concat(
        imageFiles.map((file, index) => ({
          id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      ),
    );
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pastedImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!pastedImages.length) return;
    event.preventDefault();
    addFiles(pastedImages);
  }

  function removeImage(id: string) {
    const removed = images.find((image) => image.id === id);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    onImagesChange(images.filter((image) => image.id !== id));
  }

  return (
    <div className="paste-image-field">
      <Textarea {...textareaProps} onPaste={handlePaste} />
      <div className="paste-image-toolbar">
        <span>{images.length ? `已添加 ${images.length} 张图片` : '支持直接粘贴图片'}</span>
        <label className="paste-image-button" htmlFor={inputId}>
          <ImagePlus size={15} />
          添加图片
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>
      {images.length > 0 && (
        <div className="pasted-image-list" aria-label="待提交的图片">
          {images.map((image) => (
            <div className="pasted-image" key={image.id}>
              {/* oxlint-disable-next-line next/no-img-element */}
              <img src={image.previewUrl} alt={image.file.name || '粘贴的图片'} />
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                className="pasted-image-remove"
                aria-label={`移除 ${image.file.name || '图片'}`}
                onClick={() => removeImage(image.id)}
              >
                <X size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="paste-image-error">{error}</p>}
    </div>
  );
}
