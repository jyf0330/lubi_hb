import { env } from 'cloudflare:workers';

export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_DATA_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_FILE_DATA_LENGTH = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 64;

export type EncodedImagePayload = {
  name: string;
  data: string;
  contentType?: string;
};

export type EncodedFilePayload = {
  name: string;
  data: string;
  contentType?: string;
};

export type StoredTaskAttachment = {
  id: string;
  taskId: string;
  name: string;
  contentType: string;
  size: number;
  storageKey: string;
  createdAt: number;
};

function getFiles() {
  if (!env.FILES) throw new Error('文件存储绑定 FILES 不可用。');
  return env.FILES;
}

function decodeBase64(data: string) {
  if (!data || data.length > MAX_IMAGE_DATA_LENGTH) {
    throw new Error('图片不能为空，且单张不能超过 4 MB。');
  }
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new Error('图片数据损坏，请重新粘贴。');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (!bytes.length || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('图片不能为空，且单张不能超过 4 MB。');
  }
  return bytes;
}

function decodeFileBase64(data: string) {
  if (!data || data.length > MAX_FILE_DATA_LENGTH) {
    throw new Error('文件不能为空，且单个不能超过 20 MB。');
  }
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new Error('文件数据损坏，请重新选择。');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (!bytes.length || bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error('文件不能为空，且单个不能超过 20 MB。');
  }
  return bytes;
}

function detectImage(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { contentType: 'image/png' as const, extension: 'png' };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { contentType: 'image/jpeg' as const, extension: 'jpg' };
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return { contentType: 'image/webp' as const, extension: 'webp' };
  }
  throw new Error('仅支持 PNG、JPG 和 WebP 图片。');
}

function safeName(name: string, extension: string, index: number) {
  const normalized =
    (name || `粘贴图片-${index + 1}`).replaceAll('\\', '/').split('/').pop() ||
    `粘贴图片-${index + 1}`;
  return `${normalized.slice(0, 110)}.${extension}`;
}

function safeFileName(name: string, index: number) {
  return (
    (name || `附件-${index + 1}`)
      .replaceAll('\\', '/')
      .split('/')
      .pop()
      ?.slice(0, 160) || `附件-${index + 1}`
  );
}

export async function storeTaskFiles(
  taskId: string,
  files: EncodedFilePayload[] = [],
  createdAt: number,
) {
  if (files.length > MAX_IMAGES)
    throw new Error(`最多添加 ${MAX_IMAGES} 个文件。`);
  if (!files.length) {
    return {
      records: [] as StoredTaskAttachment[],
      cleanup: async () => undefined,
    };
  }

  const bucket = getFiles();
  const keys: string[] = [];
  const records: StoredTaskAttachment[] = [];
  let totalBytes = 0;
  try {
    for (const [index, file] of files.entries()) {
      const bytes = decodeFileBase64(file.data);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_FILE_BYTES) {
        throw new Error('文件合计不能超过 40 MB。');
      }
      const id = crypto.randomUUID();
      const storageKey = `task-attachments/${taskId}/${id}`;
      const contentType = file.contentType || 'application/octet-stream';
      await bucket.put(storageKey, bytes, {
        httpMetadata: {
          contentType,
          cacheControl: 'private, max-age=31536000',
        },
      });
      keys.push(storageKey);
      records.push({
        id,
        taskId,
        name: safeFileName(file.name, index),
        contentType,
        size: bytes.byteLength,
        storageKey,
        createdAt,
      });
    }
  } catch (error) {
    await Promise.all(
      keys.map((key) => bucket.delete(key).catch(() => undefined)),
    );
    throw error;
  }

  return {
    records,
    cleanup: async () => {
      await Promise.all(
        keys.map((key) => bucket.delete(key).catch(() => undefined)),
      );
    },
  };
}

export async function storeTaskImages(
  taskId: string,
  images: EncodedImagePayload[] = [],
  createdAt: number,
) {
  if (images.length > MAX_IMAGES)
    throw new Error(`最多添加 ${MAX_IMAGES} 张图片。`);
  if (!images.length) {
    return {
      records: [] as StoredTaskAttachment[],
      cleanup: async () => undefined,
    };
  }

  const bucket = getFiles();
  const keys: string[] = [];
  const records: StoredTaskAttachment[] = [];
  let totalBytes = 0;
  try {
    for (const [index, image] of images.entries()) {
      const bytes = decodeBase64(image.data);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new Error('图片合计不能超过 12 MB。');
      const detected = detectImage(bytes);
      const id = crypto.randomUUID();
      const storageKey = `task-attachments/${taskId}/${id}.${detected.extension}`;
      await bucket.put(storageKey, bytes, {
        httpMetadata: {
          contentType: detected.contentType,
          cacheControl: 'private, max-age=31536000',
        },
      });
      keys.push(storageKey);
      records.push({
        id,
        taskId,
        name: safeName(image.name, detected.extension, index),
        contentType: detected.contentType,
        size: bytes.byteLength,
        storageKey,
        createdAt,
      });
    }
  } catch (error) {
    await Promise.all(
      keys.map((key) => bucket.delete(key).catch(() => undefined)),
    );
    throw error;
  }

  return {
    records,
    cleanup: async () => {
      await Promise.all(
        keys.map((key) => bucket.delete(key).catch(() => undefined)),
      );
    },
  };
}
