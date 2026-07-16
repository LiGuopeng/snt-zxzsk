import { NextResponse } from "next/server";

import { getDesignAssetContentType, readDesignAsset } from "@/lib/storage/design-assets";

// 这个接口需要读取服务器本地文件系统，必须使用 Node.js runtime。
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { path } = await context.params;
    // path 是 catch-all 路由拆出来的片段，例如 renders/project-id/file.png。
    const storagePath = path.join("/");
    const buffer = await readDesignAsset(storagePath);

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": getDesignAssetContentType(storagePath),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "图片不存在或无法读取",
      },
      { status: 404 },
    );
  }
}
