import { randomUUID } from "crypto";

import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/server";

const DESIGN_ASSETS_BUCKET = "design-assets";
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120);
}

function getExtension(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();

  return extension ? `.${extension}` : "";
}

function getStringField(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed || null;
}

export async function POST(request: Request) {
  try {
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

    const supabase = createSupabaseAdminClient();
    const now = new Date().toISOString();
    const intentText = getStringField(formData, "intentText");

    const { data: project, error: projectError } = await supabase
      .from("design_projects")
      .insert({
        title: "全屋效果图方案",
        status: "uploaded",
        intent_text: intentText,
        updated_at: now,
      })
      .select("id,title,status,intent_text,created_at,updated_at")
      .single();

    if (projectError || !project) {
      return NextResponse.json(
        {
          ok: false,
          error: projectError?.message || "创建效果图项目失败",
        },
        { status: 500 },
      );
    }

    const safeName = sanitizeFileName(file.name || "floor-plan");
    const storagePath = `floor-plans/${project.id}/${randomUUID()}${getExtension(safeName)}`;
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from(DESIGN_ASSETS_BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      await supabase
        .from("design_projects")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", project.id);

      return NextResponse.json(
        {
          ok: false,
          error: uploadError.message,
        },
        { status: 500 },
      );
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(DESIGN_ASSETS_BUCKET).getPublicUrl(storagePath);

    const { data: floorPlan, error: floorPlanError } = await supabase
      .from("design_floor_plans")
      .insert({
        project_id: project.id,
        file_url: publicUrl,
        storage_path: storagePath,
        file_name: safeName,
        file_type: file.type,
        file_size: file.size,
        upload_status: "uploaded",
        analysis_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .select(
        "id,project_id,file_url,storage_path,file_name,file_type,file_size,upload_status,analysis_status,created_at,updated_at",
      )
      .single();

    if (floorPlanError || !floorPlan) {
      await supabase.storage.from(DESIGN_ASSETS_BUCKET).remove([storagePath]);

      await supabase
        .from("design_projects")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", project.id);

      return NextResponse.json(
        {
          ok: false,
          error: floorPlanError?.message || "保存户型图记录失败",
        },
        { status: 500 },
      );
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
