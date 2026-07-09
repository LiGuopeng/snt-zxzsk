-- Supabase schema patch for the whole-home design render module.
-- Run this file in Supabase SQL Editor after infra/supabase/schema.sql.

create table if not exists public.design_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  title text not null default '全屋效果图方案',
  status text not null default 'draft'
    check (status in ('draft', 'uploaded', 'analyzing', 'ready', 'generating', 'completed', 'failed')),
  intent_text text,
  style text,
  budget_level text,
  color_palette text,
  house_type text,
  area numeric(8, 2),
  extracted_preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.design_projects is
  '效果图生成项目主表：串联户型图、生成任务、效果图结果和知识库检查结果。';
comment on column public.design_projects.user_id is '用户 ID，后续接登录后用于用户数据隔离。';
comment on column public.design_projects.title is '项目标题，例如“我的新家全屋方案”。';
comment on column public.design_projects.status is '项目整体状态：draft/uploaded/analyzing/ready/generating/completed/failed。';
comment on column public.design_projects.intent_text is '用户输入的自然语言全屋生成需求。';
comment on column public.design_projects.style is '系统从用户意图中抽取的装修风格，例如现代简约、奶油风。';
comment on column public.design_projects.budget_level is '系统从用户意图中抽取的预算等级，例如经济、中等、品质。';
comment on column public.design_projects.color_palette is '系统从用户意图中抽取的全屋色系，例如暖白原木。';
comment on column public.design_projects.house_type is '户型解析摘要，例如 3室2厅1卫。';
comment on column public.design_projects.area is '户型面积，单位平方米。';
comment on column public.design_projects.extracted_preferences is 'AI 从用户自然语言中抽取的结构化偏好 JSON。';

create index if not exists design_projects_user_id_idx
  on public.design_projects(user_id);

create index if not exists design_projects_status_idx
  on public.design_projects(status);

create index if not exists design_projects_updated_at_idx
  on public.design_projects(updated_at desc);

create table if not exists public.design_floor_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.design_projects(id) on delete cascade,
  file_url text not null,
  storage_path text,
  file_name text not null,
  file_type text,
  file_size bigint,
  upload_status text not null default 'uploaded'
    check (upload_status in ('uploaded', 'failed')),
  analysis_status text not null default 'pending'
    check (analysis_status in ('pending', 'analyzing', 'completed', 'failed')),
  house_type text,
  area numeric(8, 2),
  spaces jsonb not null default '[]'::jsonb,
  circulation text,
  analysis_result jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.design_floor_plans is
  '户型图表：保存上传文件信息和户型解析结果，是生成全屋效果图的必传输入。';
comment on column public.design_floor_plans.project_id is '所属效果图项目 ID。';
comment on column public.design_floor_plans.file_url is '户型图可访问地址。';
comment on column public.design_floor_plans.storage_path is '户型图在 Supabase Storage 中的对象路径。';
comment on column public.design_floor_plans.file_name is '用户上传时的原始文件名。';
comment on column public.design_floor_plans.file_type is '文件 MIME 类型，例如 image/png、image/jpeg、application/pdf。';
comment on column public.design_floor_plans.file_size is '文件大小，单位 byte。';
comment on column public.design_floor_plans.upload_status is '上传状态：uploaded/failed。';
comment on column public.design_floor_plans.analysis_status is '户型解析状态：pending/analyzing/completed/failed。';
comment on column public.design_floor_plans.house_type is '解析出的户型摘要，例如 3室2厅1卫。';
comment on column public.design_floor_plans.area is '解析出的面积，单位平方米。';
comment on column public.design_floor_plans.spaces is '解析出的空间列表 JSON，例如客厅、主卧、厨房、卫生间。';
comment on column public.design_floor_plans.circulation is '解析出的动线说明。';
comment on column public.design_floor_plans.analysis_result is '户型解析原始 JSON，保留模型或解析服务完整返回。';
comment on column public.design_floor_plans.error_message is '上传或解析失败原因。';

create index if not exists design_floor_plans_project_id_idx
  on public.design_floor_plans(project_id);

create index if not exists design_floor_plans_analysis_status_idx
  on public.design_floor_plans(analysis_status);

create table if not exists public.design_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.design_projects(id) on delete cascade,
  floor_plan_id uuid references public.design_floor_plans(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  prompt text,
  model text,
  provider text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.design_generation_jobs is
  '效果图生成任务表：保存生成全屋效果图的异步任务状态、进度、prompt 和错误信息。';
comment on column public.design_generation_jobs.project_id is '所属效果图项目 ID。';
comment on column public.design_generation_jobs.floor_plan_id is '本次生成使用的户型图 ID。';
comment on column public.design_generation_jobs.status is '任务状态：queued/running/completed/failed/cancelled。';
comment on column public.design_generation_jobs.progress is '任务进度，0 到 100。';
comment on column public.design_generation_jobs.prompt is '后端最终发送给图片生成模型的 prompt。';
comment on column public.design_generation_jobs.model is '图片生成模型名称。';
comment on column public.design_generation_jobs.provider is '图片生成服务提供方。';
comment on column public.design_generation_jobs.request_payload is '调用图片生成服务时的完整请求 JSON。';
comment on column public.design_generation_jobs.response_payload is '图片生成服务返回的完整响应 JSON。';
comment on column public.design_generation_jobs.error_message is '任务失败原因。';
comment on column public.design_generation_jobs.started_at is '任务开始时间。';
comment on column public.design_generation_jobs.completed_at is '任务完成时间。';

create index if not exists design_generation_jobs_project_id_idx
  on public.design_generation_jobs(project_id);

create index if not exists design_generation_jobs_floor_plan_id_idx
  on public.design_generation_jobs(floor_plan_id);

create index if not exists design_generation_jobs_status_idx
  on public.design_generation_jobs(status);

create index if not exists design_generation_jobs_created_at_idx
  on public.design_generation_jobs(created_at desc);

create table if not exists public.design_renders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.design_projects(id) on delete cascade,
  job_id uuid references public.design_generation_jobs(id) on delete set null,
  space_name text not null default '全屋',
  view_name text not null default '主视角',
  image_url text not null,
  thumbnail_url text,
  storage_path text,
  thumbnail_storage_path text,
  image_width integer,
  image_height integer,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.design_renders is
  '效果图结果表：保存全屋主图和各空间多视角图片，用于大图预览、缩略图、保存和导出。';
comment on column public.design_renders.project_id is '所属效果图项目 ID。';
comment on column public.design_renders.job_id is '生成该图片的任务 ID。';
comment on column public.design_renders.space_name is '空间名称，例如全屋、客厅、主卧、厨房。';
comment on column public.design_renders.view_name is '视角名称，例如主视角、沙发视角、电视墙视角。';
comment on column public.design_renders.image_url is '高清效果图访问地址。';
comment on column public.design_renders.thumbnail_url is '缩略图访问地址。';
comment on column public.design_renders.storage_path is '高清效果图在 Storage 中的对象路径。';
comment on column public.design_renders.thumbnail_storage_path is '缩略图在 Storage 中的对象路径。';
comment on column public.design_renders.image_width is '图片宽度，单位 px。';
comment on column public.design_renders.image_height is '图片高度，单位 px。';
comment on column public.design_renders.sort_order is '展示排序，数值越小越靠前。';
comment on column public.design_renders.metadata is '图片结果附加信息 JSON，例如 seed、模型参数、空间标签。';

create index if not exists design_renders_project_id_idx
  on public.design_renders(project_id);

create index if not exists design_renders_job_id_idx
  on public.design_renders(job_id);

create index if not exists design_renders_project_sort_idx
  on public.design_renders(project_id, sort_order asc, created_at asc);

create table if not exists public.design_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.design_projects(id) on delete cascade,
  job_id uuid references public.design_generation_jobs(id) on delete set null,
  review_status text not null default 'pending'
    check (review_status in ('pending', 'running', 'completed', 'failed')),
  risk_summary text,
  material_suggestions text,
  construction_risks text,
  budget_risks text,
  review_result jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.design_reviews is
  '知识库方案检查表：保存全屋效果图方案的施工、材料、预算和落地风险检查结果。';
comment on column public.design_reviews.project_id is '所属效果图项目 ID。';
comment on column public.design_reviews.job_id is '对应的生成任务 ID，可为空。';
comment on column public.design_reviews.review_status is '检查状态：pending/running/completed/failed。';
comment on column public.design_reviews.risk_summary is '整体风险摘要。';
comment on column public.design_reviews.material_suggestions is '材料建议。';
comment on column public.design_reviews.construction_risks is '施工风险。';
comment on column public.design_reviews.budget_risks is '预算风险。';
comment on column public.design_reviews.review_result is '知识库检查完整结构化结果 JSON。';
comment on column public.design_reviews.error_message is '检查失败原因。';

create index if not exists design_reviews_project_id_idx
  on public.design_reviews(project_id);

create index if not exists design_reviews_job_id_idx
  on public.design_reviews(job_id);

create index if not exists design_reviews_status_idx
  on public.design_reviews(review_status);
