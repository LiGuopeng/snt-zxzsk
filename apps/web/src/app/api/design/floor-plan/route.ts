import { NextResponse } from "next/server";

import { createPostgresClient } from "@/lib/db/postgres";
import {
  getExtension,
  removeDesignAsset,
  sanitizeFileName,
  saveDesignAsset,
} from "@/lib/storage/design-assets";

// 上传大小限制和前端保持一致；后端校验是最终防线，不能只依赖浏览器校验。
const MAX_FILE_SIZE = 15 * 1024 * 1024;
// 允许 PDF 是为了兼容真实交付场景，很多户型图会以 PDF 图纸形式给到用户。
const ALLOWED_FILE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function getStringField(formData: FormData, key: string) {
  // FormData 中除文件外还有用户补充需求；空字符串统一按 null 入库，避免后续 prompt 出现无意义空值。
  const value = formData.get(key);

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed || null;
}

export async function POST(request: Request) {
  try {
    // 上传接口只做“创建项目 + 保存户型原图 + 写入 floor_plan”，AI 解析交给独立接口处理。
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        {
          ok: false,
          error: "file is required",
        },
        { status: 400 },
      );
    }

    if (!ALLOWED_FILE_TYPES.has(file.type)) {
      return NextResponse.json(
        {
          ok: false,
          error: "只支持 JPG、PNG、WEBP 或 PDF 户型图",
        },
        { status: 400 },
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          ok: false,
          error: "户型图不能超过 15MB",
        },
        { status: 400 },
      );
    }

    const sql = createPostgresClient();
    // intentText 是用户在上传前已经填写的装修偏好，会先挂到 project 上，后续生图时继续使用。
    const intentText = getStringField(formData, "intentText");

    // 每次上传户型图都先创建一个项目，后续解析结果、全屋覆盖封面图和空间图都挂在这个 project 下。
    const [project] = await sql`
      insert into public.design_projects (title, status, intent_text, updated_at)
      values ('全屋效果图方案', 'uploaded', ${intentText}, now())
      returning id,title,status,intent_text,created_at,updated_at
    `;

    const safeName = sanitizeFileName(file.name || "floor-plan");
    // File.arrayBuffer() 只能读一次，所以先转成 Buffer，再交给统一的本地存储工具。
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    // 户型原图保存到本地文件目录，PostgreSQL 只记录 file_url/storage_path，避免数据库存大文件。
    const uploaded = await saveDesignAsset({
      buffer: fileBuffer,
      contentType: file.type,
      extension: getExtension(safeName),
      prefix: "floor-plans",
      projectId: project.id,
    });

    let floorPlan;
    try {
      // 上传完成后先标记为 pending，前端拿到 floorPlan.id 后会立即调用 analyze 接口进入“解析中”。
      [floorPlan] = await sql`
        insert into public.design_floor_plans (
          project_id,
          file_url,
          storage_path,
          file_name,
          file_type,
          file_size,
          upload_status,
          analysis_status,
          updated_at
        )
        values (
          ${project.id},
          ${uploaded.publicUrl},
          ${uploaded.storagePath},
          ${safeName},
          ${file.type},
          ${file.size},
          'uploaded',
          'pending',
          now()
        )
        returning id,project_id,file_url,storage_path,file_name,file_type,file_size,upload_status,analysis_status,created_at,updated_at
      `;
    } catch (error) {
      // 数据库写入失败时清理已经保存的文件，避免产生无法关联的孤立户型图。
      await removeDesignAsset(uploaded.storagePath);
      await sql`
        update public.design_projects
        set status = 'failed', updated_at = now()
        where id = ${project.id}
      `;
      throw error;
    }

    return NextResponse.json({
      ok: true,
      project,
      floorPlan,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
