import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

// DESIGN_ASSET_ROOT 用于线上固定图片落盘目录，避免 PM2 cwd 不一致时把图片写到错误位置。
// 默认仍兼容本地开发：apps/web 目录下启动时会写入 apps/web/public/uploads/design-assets。
const UPLOAD_ROOT = process.env.DESIGN_ASSET_ROOT
  ? path.resolve(process.env.DESIGN_ASSET_ROOT)
  : path.join(process.cwd(), "public", "uploads", "design-assets");
const PUBLIC_PREFIX = "/uploads/design-assets";

export function sanitizeFileName(fileName: string) {
  // 保留中文、英文、数字和常见扩展名字符，防止用户上传文件名里带路径或特殊符号。
  return fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120);
}

export function getExtension(fileName: string) {
  // 后续文件名会改成 UUID，这里只复用原始扩展名，保证浏览器和图片服务能识别类型。
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
  // prefix 用来区分户型原图和生成结果，projectId 用来隔离不同用户/项目的文件目录。
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

  // 这里只接收数据库里的相对 storagePath，不允许外部传绝对路径，避免误删项目目录外的文件。
  await rm(path.join(UPLOAD_ROOT, storagePath), { force: true });
}
