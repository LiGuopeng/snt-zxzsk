import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads", "design-assets");
const PUBLIC_PREFIX = "/uploads/design-assets";

export function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120);
}

export function getExtension(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();

  return extension ? `.${extension}` : "";
}

export async function saveDesignAsset(params: {
  buffer: Buffer;
  contentType?: string;
  extension?: string;
  prefix: "floor-plans" | "renders";
  projectId: string;
}) {
  // 效果图模块改为单机本地文件存储：数据库只保存可访问 URL 和相对路径，文件本体放在 public/uploads。
  const fileName = `${randomUUID()}${params.extension || ".bin"}`;
  const storagePath = `${params.prefix}/${params.projectId}/${fileName}`;
  const absolutePath = path.join(UPLOAD_ROOT, storagePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, params.buffer);

  return {
    publicUrl: `${PUBLIC_PREFIX}/${storagePath}`,
    storagePath,
  };
}

export async function readDesignAssetAsDataUrl(params: {
  contentType?: string | null;
  storagePath: string;
}) {
  // 第三方视觉模型无法访问本机相对 URL，解析时要把本地图片读成 data URL 直接传给模型。
  const buffer = await readFile(path.join(UPLOAD_ROOT, params.storagePath));
  const mimeType = params.contentType || "application/octet-stream";

  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export async function removeDesignAsset(storagePath: string | null | undefined) {
  if (!storagePath) {
    return;
  }

  await rm(path.join(UPLOAD_ROOT, storagePath), { force: true });
}
