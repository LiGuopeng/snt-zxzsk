"use client";

import { Fragment, useMemo, useState } from "react";

export type PlanTab = "renders" | "hydropower" | "budget" | "risks";

// 装修方案顶部 Tab 的配置项。这里只维护导航元信息，具体面板在下方独立组件里实现。
type PlanTabConfig = {
  id: PlanTab;
  label: string;
};

// 从户型图解析接口回填到装修方案模块的数据。
// 注意：当前接口还没有真实墙体坐标，因此水电点位图会先使用上传原图作为底图，再按空间类型生成建议点位。
type PlanFloorPlan = {
  area?: number | null;
  file_url?: string;
  house_type?: string | null;
  spaces?: Array<{
    name: string;
    type: string;
    estimated_area?: number | null;
  }>;
  circulation?: string | null;
};

// 户型解析出来的单个空间类型，抽出来是为了让水电点位生成函数的入参更清晰。
type PlanSpace = NonNullable<PlanFloorPlan["spaces"]>[number];

// 用户在引导式生成里选择的偏好，预算面板会复用 budget 字段计算报价区间。
type PlanPreferences = {
  budget?: string | null;
  feeling?: string | null;
  priority?: string | null;
};

// 预算面板的展示维度：按空间、按工程项、按软装家电。
type BudgetView = "space" | "project" | "soft";

// 预算行数据是表格的唯一渲染来源，后续接真实报价接口时保持这个结构即可替换前端估算。
type BudgetRow = {
  advice: string;
  adviceTone: "default" | "save" | "hold";
  detailItems: string[];
  id: string;
  labor: number;
  material: number;
  name: string;
  ratio: number;
  thumbnailTone: "living" | "bedroom" | "kitchen" | "bathroom" | "balcony" | "entry" | "project" | "soft";
  total: number;
};

// 预算展开区里的人工费明细行。当前是前端估算，后续可直接替换成数据库返回的人工报价明细。
type BudgetLaborDetail = {
  days: number;
  subtotal: number;
  trade: string;
  unitPrice: number;
};

// 预算展开区里的材料费明细行。采购方式用于区分装修公司供货和用户自采。
type BudgetMaterialDetail = {
  name: string;
  procurement: "装修公司提供" | "自采";
  quantity: string;
  spec: string;
  subtotal: number;
  unitPrice: number;
};

// 预算展开区里的省钱建议卡片。saving 是当前预算行可优化的预估金额。
type BudgetSavingAdvice = {
  content: string;
  saving: number;
  title: string;
};

// 软装家电的展开明细不按人工/材料拆，而是给出选购建议和备注。
type BudgetSoftDetail = {
  notes: string[];
  tips: string[];
};

// 水电点位类型。这里拆成明确枚举，方便后续和数据库里的 point_type 字段直接对齐。
type HydropowerPointType = "switch" | "socket" | "lighting" | "water" | "drain" | "strongBox" | "weakBox" | "ac";

// 水电点位在前端图上的渲染模型。
// x/y 是百分比坐标，当前用于“户型图底图上的建议落点”；等后端解析出墙体坐标后可直接替换为真实坐标。
type HydropowerPoint = {
  id: string;
  label: string;
  room: string;
  type: HydropowerPointType;
  usage: string;
  x: number;
  y: number;
};

// 按空间类型生成点位时使用的模板；不同空间会有不同的水电建议项。
type HydropowerPointTemplate = {
  label: string;
  type: HydropowerPointType;
  usage: string;
};

// 户型图被抽象成 4 列网格后，每个空间的中心点。没有真实坐标前，先用它保证点位不会全部堆在一起。
type HydropowerRoomAnchor = {
  x: number;
  y: number;
};

const PLAN_TABS: PlanTabConfig[] = [
  { id: "renders", label: "效果图" },
  { id: "hydropower", label: "水电点位图" },
  { id: "budget", label: "方案预算" },
  { id: "risks", label: "避坑提醒" },
];

const BUDGET_LEVEL_LABEL: Record<string, string> = {
  economic: "经济实用",
  standard: "中等预算",
  premium: "品质升级",
};

const MATERIAL_STRATEGY: Record<string, string[]> = {
  economic: ["环保乳胶漆", "强化复合木地板", "常规瓷砖", "成品柜体", "基础灯具"],
  standard: ["环保乳胶漆", "多层实木复合地板", "中档瓷砖", "定制柜体", "局部无主灯"],
  premium: ["艺术涂料", "实木复合地板", "大规格砖", "全屋定制柜", "无主灯系统"],
};

// 方案预算的三个切换维度。UI 只切换视图，不重新请求后端，保证响应速度。
const BUDGET_VIEW_TABS: Array<{ id: BudgetView; label: string }> = [
  { id: "space", label: "按空间" },
  { id: "project", label: "按工程项" },
  { id: "soft", label: "按软装家电" },
];

// 不同预算倾向对应的城市参考单价。这里先做前端估算，后续可替换为城市报价库。
const BUDGET_UNIT_RANGES: Record<string, [number, number]> = {
  economic: [1200, 1580],
  standard: [1680, 2060],
  premium: [2300, 3200],
};

// 户型未解析出空间时使用的兜底空间结构，保证预算页进入时仍有完整表格骨架。
const BUDGET_FALLBACK_SPACES: PlanSpace[] = [
  { name: "客厅", type: "living", estimated_area: 26 },
  { name: "主卧", type: "bedroom", estimated_area: 18 },
  { name: "次卧", type: "bedroom", estimated_area: 15 },
  { name: "厨房", type: "kitchen", estimated_area: 9 },
  { name: "卫生间", type: "bathroom", estimated_area: 6 },
  { name: "阳台", type: "balcony", estimated_area: 7 },
  { name: "玄关", type: "entry", estimated_area: 4 },
];

// 空间没有面积时按装修复杂度分配预算权重。厨卫权重更高，因为水电、防水、瓷砖和设备更多。
const BUDGET_SPACE_WEIGHTS: Record<string, number> = {
  living: 18,
  bedroom: 14,
  kitchen: 20,
  bathroom: 13,
  balcony: 8,
  entry: 5,
  default: 9,
};

// 按工程项拆预算时的固定比例，合计为 1。
const BUDGET_PROJECT_ITEMS = [
  { id: "demolition", name: "拆改与保护", ratio: 0.08, laborRatio: 0.56, detailItems: ["成品保护", "局部拆改", "垃圾清运"] },
  { id: "hydropower", name: "水电工程", ratio: 0.18, laborRatio: 0.42, detailItems: ["强弱电改造", "给排水改造", "开槽布管"] },
  { id: "waterproof", name: "防水工程", ratio: 0.08, laborRatio: 0.38, detailItems: ["厨卫防水", "闭水试验", "阳台防水"] },
  { id: "tiling", name: "泥瓦工程", ratio: 0.24, laborRatio: 0.34, detailItems: ["墙地砖铺贴", "找平", "门槛石收口"] },
  { id: "wood", name: "木作油漆", ratio: 0.23, laborRatio: 0.32, detailItems: ["吊顶", "墙面基层", "乳胶漆"] },
  { id: "install", name: "安装收口", ratio: 0.19, laborRatio: 0.28, detailItems: ["灯具洁具安装", "开关面板", "五金收口"] },
];

// 按软装家电拆预算时的固定比例，体现“效果图风格 -> 材料/软装预算”的关联。
const BUDGET_SOFT_ITEMS = [
  { id: "appliance", name: "家用电器", ratio: 0.32, laborRatio: 0.04, detailItems: ["冰箱", "洗衣机", "空调", "电视", "厨房电器套装"] },
  { id: "furniture", name: "软装家具", ratio: 0.3, laborRatio: 0.06, detailItems: ["沙发", "茶几边几", "餐桌椅", "窗帘", "灯具", "装饰画"] },
  { id: "cabinet", name: "定制柜体", ratio: 0.24, laborRatio: 0.12, detailItems: ["玄关柜", "衣柜", "餐边柜", "阳台柜"] },
  { id: "lighting", name: "灯具窗帘", ratio: 0.14, laborRatio: 0.08, detailItems: ["主灯", "筒射灯", "轨道灯", "窗帘轨道"] },
];

// 水电点位类型的展示配置。颜色和短标签会同时用于筛选按钮、图例和点位标记。
const HYDROPOWER_TYPES: Array<{
  colorClassName: string;
  id: HydropowerPointType | "all";
  label: string;
  shortLabel: string;
}> = [
  { id: "all", label: "全部", shortLabel: "全", colorClassName: "bg-[#0969ff]" },
  { id: "switch", label: "开关", shortLabel: "开", colorClassName: "bg-[#1677ff]" },
  { id: "socket", label: "插座", shortLabel: "插", colorClassName: "bg-[#ff7a1a]" },
  { id: "lighting", label: "照明", shortLabel: "灯", colorClassName: "bg-[#f5b400]" },
  { id: "water", label: "给水点", shortLabel: "水", colorClassName: "bg-[#19a7ce]" },
  { id: "drain", label: "排水点", shortLabel: "排", colorClassName: "bg-[#0ea5e9]" },
  { id: "strongBox", label: "强电箱", shortLabel: "强", colorClassName: "bg-[#2563eb]" },
  { id: "weakBox", label: "弱电箱", shortLabel: "弱", colorClassName: "bg-[#7c3aed]" },
  { id: "ac", label: "空调点位", shortLabel: "空", colorClassName: "bg-[#16a34a]" },
];

// 空间默认名称用于“还没有上传户型图”时的兜底预览，避免页面空白。
const HYDROPOWER_FALLBACK_ROOMS = ["厨房", "公卫", "次卧", "主卧", "儿童房", "客厅", "走廊", "玄关", "阳台"];

// 没有解析空间时的兜底点位。真实使用时优先走 buildHydropowerPoints(floorPlan)。
const HYDROPOWER_FALLBACK_POINTS: HydropowerPoint[] = [
  { id: "living-socket-tv", label: "电视墙插座", room: "客厅", type: "socket", usage: "电视设备、电源排插使用", x: 48, y: 58 },
  { id: "living-switch", label: "客厅双控开关", room: "客厅", type: "switch", usage: "控制主灯和辅助灯带", x: 38, y: 50 },
  { id: "living-light", label: "客厅主照明", room: "客厅", type: "lighting", usage: "主灯或无主灯中心点位", x: 51, y: 50 },
  { id: "living-ac", label: "客厅空调点位", room: "客厅", type: "ac", usage: "柜机或风管机预留", x: 62, y: 46 },
  { id: "kitchen-water", label: "厨房给水点", room: "厨房", type: "water", usage: "水槽、净水器、洗碗机预留", x: 24, y: 25 },
  { id: "kitchen-drain", label: "厨房排水点", room: "厨房", type: "drain", usage: "水槽和洗碗机排水", x: 20, y: 30 },
  { id: "kitchen-socket", label: "厨房小厨电插座", room: "厨房", type: "socket", usage: "台面小厨电和冰箱使用", x: 32, y: 31 },
  { id: "bath-water", label: "卫生间给水点", room: "卫生间", type: "water", usage: "浴室柜、淋浴、马桶预留", x: 74, y: 28 },
  { id: "bath-drain", label: "卫生间排水点", room: "卫生间", type: "drain", usage: "地漏、马桶、浴室柜排水", x: 80, y: 32 },
  { id: "bedroom-switch", label: "卧室双控开关", room: "主卧", type: "switch", usage: "门口和床头双控", x: 80, y: 66 },
  { id: "bedroom-socket", label: "床头五孔插座", room: "主卧", type: "socket", usage: "手机充电和床头灯使用", x: 86, y: 71 },
  { id: "bedroom-light", label: "卧室照明", room: "主卧", type: "lighting", usage: "主灯或无主灯点位", x: 75, y: 70 },
  { id: "child-socket", label: "儿童房插座", room: "儿童房", type: "socket", usage: "书桌、台灯、学习设备使用", x: 19, y: 67 },
  { id: "child-light", label: "儿童房照明", room: "儿童房", type: "lighting", usage: "护眼主照明点位", x: 25, y: 71 },
  { id: "entry-strong", label: "强电箱", room: "玄关", type: "strongBox", usage: "入户配电箱位置", x: 18, y: 43 },
  { id: "entry-weak", label: "弱电箱", room: "玄关", type: "weakBox", usage: "路由器、光猫、网络汇聚", x: 24, y: 43 },
];

// 按空间语义匹配点位模板。后续如果接入真实水电规则库，可以把这个常量替换成接口返回。
const HYDROPOWER_TEMPLATES_BY_ROOM_KIND: Record<string, HydropowerPointTemplate[]> = {
  living: [
    { label: "电视墙插座", type: "socket", usage: "电视、路由、影音设备预留电源" },
    { label: "客厅双控开关", type: "switch", usage: "玄关和客厅入口双控主照明" },
    { label: "客厅主照明", type: "lighting", usage: "主灯、无主灯或磁吸轨道中心点位" },
    { label: "客厅空调点位", type: "ac", usage: "柜机、挂机或风管机预留电源" },
  ],
  kitchen: [
    { label: "厨房给水点", type: "water", usage: "水槽、净水器、洗碗机给水预留" },
    { label: "厨房排水点", type: "drain", usage: "水槽、洗碗机和地漏排水预留" },
    { label: "台面小厨电插座", type: "socket", usage: "电饭煲、咖啡机、烧水壶等台面电器" },
    { label: "厨房照明", type: "lighting", usage: "主照明和操作台补光点位" },
  ],
  bathroom: [
    { label: "卫生间给水点", type: "water", usage: "浴室柜、淋浴、马桶给水预留" },
    { label: "卫生间排水点", type: "drain", usage: "地漏、马桶、浴室柜排水预留" },
    { label: "镜柜插座", type: "socket", usage: "吹风机、电动牙刷、智能镜柜使用" },
    { label: "卫生间照明", type: "lighting", usage: "主照明、镜前灯和浴霸位置" },
  ],
  bedroom: [
    { label: "床头五孔插座", type: "socket", usage: "手机充电、床头灯、智能设备使用" },
    { label: "卧室双控开关", type: "switch", usage: "门口和床头双控照明" },
    { label: "卧室照明", type: "lighting", usage: "主灯或无主灯点位" },
    { label: "卧室空调点位", type: "ac", usage: "挂机或风管机预留电源" },
  ],
  balcony: [
    { label: "阳台给水点", type: "water", usage: "洗衣机、洗手池或清洁龙头预留" },
    { label: "阳台排水点", type: "drain", usage: "洗衣机和地漏排水预留" },
    { label: "洗衣机插座", type: "socket", usage: "洗衣机、烘干机或扫地机使用" },
  ],
  entry: [
    { label: "强电箱", type: "strongBox", usage: "入户配电箱位置，需避开潮湿区域" },
    { label: "弱电箱", type: "weakBox", usage: "光猫、路由器、网络汇聚点" },
    { label: "玄关开关", type: "switch", usage: "入户灯、过道灯控制" },
  ],
  default: [
    { label: "基础插座", type: "socket", usage: "常规电器和清洁设备使用" },
    { label: "照明点位", type: "lighting", usage: "空间主照明或辅助照明" },
    { label: "门口开关", type: "switch", usage: "进入空间时控制主灯" },
  ],
};

// 每个空间内部多个点位的相对偏移，避免同一个房间内点位完全重叠。
const HYDROPOWER_POINT_OFFSETS: HydropowerRoomAnchor[] = [
  { x: -6, y: -4 },
  { x: 5, y: -5 },
  { x: -4, y: 5 },
  { x: 6, y: 5 },
];

// 空间锚点按常见户型布局分布。没有真实坐标时，它保证“客厅、厨卫、卧室”等点位大致散落在图面上。
const HYDROPOWER_ROOM_ANCHORS: HydropowerRoomAnchor[] = [
  { x: 24, y: 24 },
  { x: 48, y: 24 },
  { x: 72, y: 24 },
  { x: 24, y: 50 },
  { x: 50, y: 50 },
  { x: 76, y: 50 },
  { x: 24, y: 74 },
  { x: 50, y: 74 },
  { x: 76, y: 74 },
];

function mapBudgetToQuoteLevel(budget?: string | null) {
  if (budget === "经济实用") {
    return "economic";
  }

  if (budget === "品质升级") {
    return "premium";
  }

  return "standard";
}

function getSpaceNames(floorPlan: PlanFloorPlan | null) {
  return floorPlan?.spaces?.length ? floorPlan.spaces.map((space) => space.name).join("、") : "户型解析完成后自动带入空间";
}

function getBudgetRange(area: number | null | undefined, level: string) {
  if (!area) {
    return null;
  }

  const [minUnitPrice, maxUnitPrice] = BUDGET_UNIT_RANGES[level] || BUDGET_UNIT_RANGES.standard;
  const min = Math.round((area * minUnitPrice) / 1000) * 1000;
  const max = Math.round((area * maxUnitPrice) / 1000) * 1000;

  return {
    max,
    min,
    recommended: Math.round(((min + max) / 2) / 100) * 100,
    unitMin: minUnitPrice,
    unitMax: maxUnitPrice,
  };
}

function formatMoney(value: number) {
  return `¥ ${value.toLocaleString("zh-CN")}`;
}

function formatBudgetNumber(value: number) {
  // 表格里不展示货币符号，和设计稿保持一致，只保留千分位数字。
  return value.toLocaleString("zh-CN");
}

function roundBudgetValue(value: number, unit = 100) {
  // 预算估算统一按百元取整，避免出现过细但并不真实的个位数报价。
  return Math.max(unit, Math.round(value / unit) * unit);
}

function getBudgetArea(floorPlan: PlanFloorPlan | null) {
  // 面积是预算计算的基础；户型未解析完成时用 100 平作为临时预估，不让预算页空白。
  return {
    area: floorPlan?.area || 100,
    estimated: !floorPlan?.area,
  };
}

function getBudgetAdjustedValue(recommendedBudget: number, preferences: PlanPreferences) {
  // “自定义调整后”先根据用户偏好做轻量调整，后续可以替换为真正的预算编辑器结果。
  const budgetFactor = preferences.budget === "经济实用" ? 0.94 : preferences.budget === "品质升级" ? 1.08 : 0.97;
  const priorityFactor = preferences.priority === "预算控制" ? 0.96 : 1;

  return roundBudgetValue(recommendedBudget * budgetFactor * priorityFactor);
}

function getBudgetRoomKind(space: PlanSpace) {
  // 预算和水电都需要识别空间类型，但预算更关注“装修复杂度”，所以单独保留一套归类函数。
  const rawName = `${space.type || ""} ${space.name || ""}`.toLowerCase();

  if (rawName.includes("厨") || rawName.includes("kitchen")) {
    return "kitchen";
  }

  if (rawName.includes("卫") || rawName.includes("bath") || rawName.includes("toilet") || rawName.includes("洗手间")) {
    return "bathroom";
  }

  if (rawName.includes("客") || rawName.includes("living")) {
    return "living";
  }

  if (rawName.includes("卧") || rawName.includes("bed") || rawName.includes("儿童房") || rawName.includes("老人房")) {
    return "bedroom";
  }

  if (rawName.includes("阳台") || rawName.includes("balcony")) {
    return "balcony";
  }

  if (rawName.includes("玄关") || rawName.includes("入户") || rawName.includes("走廊") || rawName.includes("过道")) {
    return "entry";
  }

  return "default";
}

function getBudgetAdvice(roomKind: string, ratio: number) {
  // 建议标签只表达预算策略，不做施工结论，避免把估算结果包装成确定报价。
  if (roomKind === "bathroom" || roomKind === "kitchen") {
    return { advice: "不建议改动", adviceTone: "hold" as const };
  }

  if (ratio >= 18) {
    return { advice: "适中，建议保留", adviceTone: "default" as const };
  }

  return { advice: "可省", adviceTone: "save" as const };
}

function getBudgetDetailItemsForRoom(roomKind: string, materials: string[]) {
  // 详情项让“展开”有可解释内容，同时把预算倾向对应的材料策略带进来。
  if (roomKind === "kitchen") {
    return ["橱柜及台面", "墙地砖", "水电点位", materials[2] || "常规瓷砖"];
  }

  if (roomKind === "bathroom") {
    return ["防水工程", "洁具五金", "墙地砖", "给排水点位"];
  }

  if (roomKind === "living") {
    return ["墙顶面处理", "地面材料", "灯光点位", materials[4] || "基础灯具"];
  }

  if (roomKind === "bedroom") {
    return ["墙面处理", "地面材料", "衣柜衔接", materials[1] || "复合地板"];
  }

  if (roomKind === "balcony") {
    return ["防水处理", "地砖铺贴", "洗衣机点位"];
  }

  if (roomKind === "entry") {
    return ["玄关柜衔接", "开关点位", "地面收口"];
  }

  return ["基础硬装", "主材配置", "安装收口"];
}

function getBudgetThumbnailTone(roomKind: string): BudgetRow["thumbnailTone"] {
  // 缩略图色调只做视觉区分，不代表真实效果图。
  if (roomKind === "kitchen") {
    return "kitchen";
  }

  if (roomKind === "bathroom") {
    return "bathroom";
  }

  if (roomKind === "living") {
    return "living";
  }

  if (roomKind === "bedroom") {
    return "bedroom";
  }

  if (roomKind === "balcony") {
    return "balcony";
  }

  if (roomKind === "entry") {
    return "entry";
  }

  return "project";
}

function getSpaceBudgetRows(floorPlan: PlanFloorPlan | null, totalBudget: number, materials: string[]) {
  // 按空间分摊预算：优先用解析面积，没有面积时按空间装修复杂度权重分配。
  const spaces = floorPlan?.spaces?.length ? floorPlan.spaces : BUDGET_FALLBACK_SPACES;
  const weightedSpaces = spaces.map((space, index) => {
    const roomKind = getBudgetRoomKind(space);
    const areaWeight = space.estimated_area && space.estimated_area > 0 ? space.estimated_area : null;
    const weight = areaWeight || BUDGET_SPACE_WEIGHTS[roomKind] || BUDGET_SPACE_WEIGHTS.default;

    return {
      index,
      roomKind,
      space,
      weight,
    };
  });
  const totalWeight = weightedSpaces.reduce((sum, item) => sum + item.weight, 0) || 1;

  return weightedSpaces.map((item) => {
    const ratio = Number(((item.weight / totalWeight) * 100).toFixed(1));
    const total = roundBudgetValue(totalBudget * item.weight / totalWeight);
    const laborRatio = item.roomKind === "kitchen" || item.roomKind === "bathroom" ? 0.23 : item.roomKind === "entry" ? 0.21 : 0.2;
    const labor = roundBudgetValue(total * laborRatio);
    const material = Math.max(0, total - labor);
    const budgetAdvice = getBudgetAdvice(item.roomKind, ratio);

    return {
      ...budgetAdvice,
      detailItems: getBudgetDetailItemsForRoom(item.roomKind, materials),
      id: `space-${item.index}-${item.space.name}`,
      labor,
      material,
      name: item.space.name,
      ratio,
      thumbnailTone: getBudgetThumbnailTone(item.roomKind),
      total,
    };
  });
}

function getProjectBudgetRows(totalBudget: number) {
  // 按工程项拆预算，用于用户从“钱花在哪些施工环节”角度查看。
  return BUDGET_PROJECT_ITEMS.map((item) => {
    const total = roundBudgetValue(totalBudget * item.ratio);
    const labor = roundBudgetValue(total * item.laborRatio);

    return {
      advice: item.id === "hydropower" || item.id === "waterproof" ? "优先保障" : "适中，建议保留",
      adviceTone: item.id === "hydropower" || item.id === "waterproof" ? "hold" as const : "default" as const,
      detailItems: item.detailItems,
      id: `project-${item.id}`,
      labor,
      material: Math.max(0, total - labor),
      name: item.name,
      ratio: Number((item.ratio * 100).toFixed(1)),
      thumbnailTone: "project" as const,
      total,
    };
  });
}

function getSoftBudgetRows(totalBudget: number) {
  // 软装家电通常不全部进入硬装合同，这里按推荐预算的 35% 做独立参考。
  const softBudget = totalBudget * 0.35;

  return BUDGET_SOFT_ITEMS.map((item) => {
    const total = roundBudgetValue(softBudget * item.ratio);
    const labor = roundBudgetValue(total * item.laborRatio);

    return {
      advice: item.id === "cabinet" ? "重点控制" : "可省",
      adviceTone: item.id === "cabinet" ? "default" as const : "save" as const,
      detailItems: item.detailItems,
      id: `soft-${item.id}`,
      labor,
      material: Math.max(0, total - labor),
      name: item.name,
      ratio: Number((item.ratio * 100).toFixed(1)),
      thumbnailTone: "soft" as const,
      total,
    };
  });
}

function getBudgetRows(view: BudgetView, floorPlan: PlanFloorPlan | null, totalBudget: number, materials: string[]) {
  // 统一出口：BudgetPlanPanel 只关心当前视图拿到哪些行，不关心每种维度怎么计算。
  if (view === "project") {
    return getProjectBudgetRows(totalBudget);
  }

  if (view === "soft") {
    return getSoftBudgetRows(totalBudget);
  }

  return getSpaceBudgetRows(floorPlan, totalBudget, materials);
}

function getBudgetFirstColumnLabel(view: BudgetView) {
  if (view === "project") {
    return "工程项";
  }

  if (view === "soft") {
    return "软装家电";
  }

  return "空间";
}

function getBudgetThumbnailClassName(tone: BudgetRow["thumbnailTone"]) {
  // 预算表缩略图使用纯 CSS 质感块，避免引入外部图片导致部署环境加载失败。
  const classNames: Record<BudgetRow["thumbnailTone"], string> = {
    balcony: "bg-[linear-gradient(135deg,#eee8dd,#b9c4ba)]",
    bathroom: "bg-[linear-gradient(135deg,#f7f8f8,#b8c5cf)]",
    bedroom: "bg-[linear-gradient(135deg,#eadfce,#9a8268)]",
    entry: "bg-[linear-gradient(135deg,#eee7dc,#8d745e)]",
    kitchen: "bg-[linear-gradient(135deg,#efece7,#b58b63)]",
    living: "bg-[linear-gradient(135deg,#eee9df,#7f7466)]",
    project: "bg-[linear-gradient(135deg,#e8eef8,#7f94b8)]",
    soft: "bg-[linear-gradient(135deg,#f2e7df,#c09276)]",
  };

  return classNames[tone];
}

function getBudgetAdviceClassName(tone: BudgetRow["adviceTone"]) {
  if (tone === "save") {
    return "bg-[#e8f8ef] text-[#13875a]";
  }

  if (tone === "hold") {
    return "text-[#42557d]";
  }

  return "text-[#42557d]";
}

function splitBudgetAmount(total: number, weights: number[]) {
  // 把一笔预算按权重拆成多行明细，并修正最后一项，保证明细合计等于主表金额。
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const values = weights.map((weight) => Math.round((total * weight) / totalWeight / 10) * 10);
  const diff = total - values.reduce((sum, value) => sum + value, 0);
  const lastIndex = values.length - 1;

  values[lastIndex] = Math.max(0, values[lastIndex] + diff);

  return values;
}

function getBudgetLaborSeeds(row: BudgetRow, view: BudgetView) {
  // 不同维度展开时，人工明细的工种不同：空间看现场工种，工程项看该工程的专业工种。
  if (view === "project") {
    if (row.name.includes("水电")) {
      return [
        { trade: "水电工", unitPrice: 380, weight: 5 },
        { trade: "开槽布管", unitPrice: 320, weight: 3 },
        { trade: "安装调试", unitPrice: 300, weight: 2 },
      ];
    }

    if (row.name.includes("泥瓦")) {
      return [
        { trade: "瓦工", unitPrice: 420, weight: 5 },
        { trade: "找平工", unitPrice: 360, weight: 2 },
        { trade: "美缝收口", unitPrice: 260, weight: 1.5 },
      ];
    }

    if (row.name.includes("木") || row.name.includes("油漆")) {
      return [
        { trade: "木工", unitPrice: 460, weight: 4 },
        { trade: "定制安装收口", unitPrice: 360, weight: 3 },
        { trade: "基层修补", unitPrice: 220, weight: 1.5 },
        { trade: "油漆工", unitPrice: 300, weight: 2 },
      ];
    }

    if (row.name.includes("安装")) {
      return [
        { trade: "洁具安装", unitPrice: 300, weight: 2 },
        { trade: "灯具安装", unitPrice: 260, weight: 2 },
        { trade: "五金收口", unitPrice: 220, weight: 1.5 },
      ];
    }

    return [
      { trade: "拆改工", unitPrice: 360, weight: 3 },
      { trade: "保护施工", unitPrice: 260, weight: 1.5 },
      { trade: "垃圾清运", unitPrice: 240, weight: 1.5 },
    ];
  }

  if (row.thumbnailTone === "kitchen") {
    return [
      { trade: "水电工", unitPrice: 360, weight: 3 },
      { trade: "瓦工", unitPrice: 420, weight: 4 },
      { trade: "橱柜安装", unitPrice: 380, weight: 2 },
      { trade: "收口杂工", unitPrice: 240, weight: 1 },
    ];
  }

  if (row.thumbnailTone === "bathroom") {
    return [
      { trade: "水电工", unitPrice: 360, weight: 2 },
      { trade: "防水工", unitPrice: 320, weight: 2 },
      { trade: "瓦工", unitPrice: 420, weight: 3 },
      { trade: "洁具安装", unitPrice: 280, weight: 1 },
    ];
  }

  if (row.thumbnailTone === "bedroom") {
    return [
      { trade: "木工", unitPrice: 420, weight: 2 },
      { trade: "油漆工", unitPrice: 360, weight: 3 },
      { trade: "安装工", unitPrice: 280, weight: 1.5 },
      { trade: "杂工", unitPrice: 230, weight: 1 },
    ];
  }

  if (row.thumbnailTone === "balcony") {
    return [
      { trade: "防水工", unitPrice: 320, weight: 2 },
      { trade: "瓦工", unitPrice: 380, weight: 2 },
      { trade: "安装工", unitPrice: 260, weight: 1 },
    ];
  }

  return [
    { trade: "水电工", unitPrice: 320, weight: 2 },
    { trade: "瓦工", unitPrice: 380, weight: 2.5 },
    { trade: "木工", unitPrice: 420, weight: 2 },
    { trade: "油漆工", unitPrice: 360, weight: 2 },
    { trade: "杂工", unitPrice: 230, weight: 1 },
  ];
}

function getBudgetLaborDetails(row: BudgetRow, view: BudgetView): BudgetLaborDetail[] {
  // 人工明细的金额来自主表人工费拆分，保证用户展开后能对上主表汇总。
  // seeds 是当前预算行对应的工种模板，后续真实报价接口可直接返回同结构数据替换它。
  const seeds = getBudgetLaborSeeds(row, view);
  // subtotals 按工种权重拆分主表人工费，避免展开明细合计和主表金额不一致。
  const subtotals = splitBudgetAmount(row.labor, seeds.map((seed) => seed.weight));

  return seeds.map((seed, index) => ({
    days: Number((subtotals[index] / seed.unitPrice).toFixed(1)),
    subtotal: subtotals[index],
    trade: seed.trade,
    unitPrice: seed.unitPrice,
  }));
}

function getBudgetMaterialSeeds(row: BudgetRow, view: BudgetView) {
  // 材料明细优先按空间/工程项语义生成，当前不依赖外部图片或第三方报价库。
  if (view === "project") {
    if (row.name.includes("水电")) {
      return [
        { name: "阻燃电线", spec: "BV 2.5/4mm", quantity: "260 m", unitPrice: 4.8, procurement: "装修公司提供" as const, weight: 4 },
        { name: "弱电网线", spec: "六类非屏蔽", quantity: "120 m", unitPrice: 3.5, procurement: "装修公司提供" as const, weight: 1.5 },
        { name: "PPR给水管", spec: "20/25mm", quantity: "42 m", unitPrice: 28, procurement: "装修公司提供" as const, weight: 2 },
        { name: "PVC排水管", spec: "50/75/110mm", quantity: "24 m", unitPrice: 32, procurement: "装修公司提供" as const, weight: 1.5 },
        { name: "开关底盒", spec: "86型", quantity: "45 个", unitPrice: 8, procurement: "装修公司提供" as const, weight: 1 },
      ];
    }

    if (row.name.includes("木") || row.name.includes("油漆")) {
      return [
        { name: "E1级多层板", spec: "18mm", quantity: "28 张", unitPrice: 420, procurement: "装修公司提供" as const, weight: 4 },
        { name: "E1级生态板", spec: "9mm", quantity: "18 张", unitPrice: 180, procurement: "装修公司提供" as const, weight: 2 },
        { name: "防潮板", spec: "18mm", quantity: "18 ㎡", unitPrice: 95, procurement: "自采" as const, weight: 1.5 },
        { name: "实木线条", spec: "25x15mm", quantity: "30 m", unitPrice: 25, procurement: "装修公司提供" as const, weight: 1 },
        { name: "五金合页", spec: "不锈钢缓冲", quantity: "12 只", unitPrice: 35, procurement: "装修公司提供" as const, weight: 0.8 },
        { name: "木工辅料", spec: "胶水、钉子等", quantity: "1 套", unitPrice: 120, procurement: "装修公司提供" as const, weight: 0.7 },
      ];
    }

    if (row.name.includes("泥瓦")) {
      return [
        { name: "地砖", spec: "800x800", quantity: "65 ㎡", unitPrice: 120, procurement: "装修公司提供" as const, weight: 4 },
        { name: "墙砖", spec: "300x600", quantity: "48 ㎡", unitPrice: 95, procurement: "装修公司提供" as const, weight: 3 },
        { name: "瓷砖胶", spec: "C1级", quantity: "18 袋", unitPrice: 55, procurement: "装修公司提供" as const, weight: 1.2 },
        { name: "美缝剂", spec: "环氧彩砂", quantity: "1 项", unitPrice: 1200, procurement: "自采" as const, weight: 1 },
      ];
    }

    return [
      { name: "保护膜", spec: "加厚", quantity: "1 批", unitPrice: 680, procurement: "装修公司提供" as const, weight: 2 },
      { name: "辅材", spec: "常规", quantity: "1 批", unitPrice: 1200, procurement: "装修公司提供" as const, weight: 3 },
      { name: "五金收口", spec: "通用", quantity: "1 批", unitPrice: 800, procurement: "自采" as const, weight: 1 },
    ];
  }

  if (row.thumbnailTone === "kitchen") {
    return [
      { name: "墙地砖", spec: "600x600", quantity: "32 ㎡", unitPrice: 120, procurement: "装修公司提供" as const, weight: 3 },
      { name: "橱柜板材", spec: "E1级多层板", quantity: "8 延米", unitPrice: 980, procurement: "装修公司提供" as const, weight: 4 },
      { name: "石英石台面", spec: "15mm", quantity: "5 m", unitPrice: 680, procurement: "装修公司提供" as const, weight: 2 },
      { name: "水槽龙头", spec: "常规套装", quantity: "1 套", unitPrice: 1200, procurement: "自采" as const, weight: 1 },
    ];
  }

  if (row.thumbnailTone === "bathroom") {
    return [
      { name: "防水涂料", spec: "柔性防水", quantity: "18 ㎡", unitPrice: 65, procurement: "装修公司提供" as const, weight: 1.5 },
      { name: "墙地砖", spec: "300x600", quantity: "38 ㎡", unitPrice: 110, procurement: "装修公司提供" as const, weight: 3 },
      { name: "浴室柜", spec: "80cm", quantity: "1 套", unitPrice: 1800, procurement: "自采" as const, weight: 1.5 },
      { name: "洁具五金", spec: "马桶/花洒", quantity: "1 套", unitPrice: 3200, procurement: "自采" as const, weight: 2 },
    ];
  }

  if (row.thumbnailTone === "bedroom") {
    return [
      { name: "乳胶漆", spec: "立邦净味120", quantity: "42 ㎡", unitPrice: 45, procurement: "装修公司提供" as const, weight: 2 },
      { name: "木地板", spec: "复合地板15mm", quantity: "18 ㎡", unitPrice: 160, procurement: "装修公司提供" as const, weight: 3 },
      { name: "踢脚线", spec: "实木复合", quantity: "24 m", unitPrice: 25, procurement: "自采" as const, weight: 1 },
      { name: "开关插座", spec: "西门子", quantity: "1 套", unitPrice: 350, procurement: "装修公司提供" as const, weight: 1 },
    ];
  }

  return [
    { name: "地砖", spec: "800x800", quantity: "65 ㎡", unitPrice: 120, procurement: "装修公司提供" as const, weight: 4 },
    { name: "乳胶漆", spec: "立邦净味120", quantity: "45 ㎡", unitPrice: 45, procurement: "装修公司提供" as const, weight: 1.5 },
    { name: "木地板", spec: "复合地板15mm", quantity: "32 ㎡", unitPrice: 160, procurement: "装修公司提供" as const, weight: 2.5 },
    { name: "石膏板", spec: "12mm", quantity: "25 张", unitPrice: 75, procurement: "自采" as const, weight: 1 },
    { name: "踢脚线", spec: "实木复合", quantity: "45 m", unitPrice: 25, procurement: "自采" as const, weight: 0.8 },
    { name: "灯具", spec: "吸顶灯等", quantity: "1 套", unitPrice: 680, procurement: "装修公司提供" as const, weight: 0.7 },
    { name: "开关插座", spec: "西门子", quantity: "1 套", unitPrice: 350, procurement: "装修公司提供" as const, weight: 0.5 },
  ];
}

function getBudgetMaterialDetails(row: BudgetRow, view: BudgetView): BudgetMaterialDetail[] {
  // 材料明细同样从主表材料费拆分，保证展开明细和汇总金额一致。
  // seeds 是材料模板，先覆盖常见空间和工程项，后续会迁移到材料库或报价接口。
  const seeds = getBudgetMaterialSeeds(row, view);
  // subtotals 用主表材料费反推各材料小计，当前阶段优先保证金额闭合。
  const subtotals = splitBudgetAmount(row.material, seeds.map((seed) => seed.weight));

  return seeds.map((seed, index) => ({
    name: seed.name,
    procurement: seed.procurement,
    quantity: seed.quantity,
    spec: seed.spec,
    subtotal: subtotals[index],
    unitPrice: seed.unitPrice,
  }));
}

function getBudgetSavingAdvice(row: BudgetRow, view: BudgetView): BudgetSavingAdvice {
  // 省钱建议按当前行语义生成，优先保护水电、防水、厨卫等关键质量项。
  if (view === "project" && (row.name.includes("水电") || row.name.includes("防水"))) {
    return {
      content: `${row.name}不建议直接压缩单价，应重点核对工程量、材料规格和点位数量，避免后期返工成本更高。`,
      saving: 0,
      title: "质量优先",
    };
  }

  if (view === "project" && (row.name.includes("木") || row.name.includes("油漆"))) {
    return {
      content: "柜门可根据整体风格选择性价比更高的饰面板，部分辅料建议自采，预计可节省约 5000 元，不影响整体使用寿命和美观度。",
      saving: Math.min(5000, roundBudgetValue(row.material * 0.18)),
      title: "省钱建议",
    };
  }

  if (row.thumbnailTone === "kitchen" || row.thumbnailTone === "bathroom") {
    return {
      content: `${row.name}涉及水电、防水和高频使用设备，建议优先保留基础质量，只在五金品牌、柜体配置和部分装饰项上优化。`,
      saving: Math.min(1800, roundBudgetValue(row.material * 0.08)),
      title: "谨慎优化",
    };
  }

  return {
    content: `${row.name}地砖可选择性价比更高的品牌或规格，乳胶漆可关注促销套装，部分装饰线条建议自采，可有效降低成本。`,
    saving: Math.min(3000, roundBudgetValue(row.material * 0.14)),
    title: "省钱建议",
  };
}

function getBudgetSoftQuantity(row: BudgetRow) {
  // 软装主表展示品类数量，不把它误拆成人工/材料。
  return `${row.detailItems.length}项`;
}

function getBudgetSoftUnitPrice(row: BudgetRow) {
  // itemCount 表示当前软装品类下包含的子项数量，用于估算品类平均单价。
  const itemCount = Math.max(1, row.detailItems.length);

  return roundBudgetValue(row.total / itemCount);
}

function getBudgetSoftDetail(row: BudgetRow): BudgetSoftDetail {
  // 软装家电展开后给采购建议和备注，贴近用户真正决策时需要的信息。
  if (row.name.includes("家用电器")) {
    return {
      notes: ["预留上水、排水及强电电源插座", "洗衣机摆放位需核对卫生间门洞尺寸"],
      tips: ["预算控制统一体，型号节能，兼顾健康", "优先选择 10kg 容量，满足家庭日常洗护需求"],
    };
  }

  if (row.name.includes("软装家具")) {
    return {
      notes: ["沙发、餐桌需结合全屋动线尺寸复核", "窗帘建议等硬装完成后复尺"],
      tips: ["沙发和餐桌椅先确定尺寸，再确定款式", "装饰画、地毯可后置购买，降低一次性支出"],
    };
  }

  if (row.name.includes("定制柜体")) {
    return {
      notes: ["柜体报价需明确板材等级、封边、五金和投影面积算法", "柜门颜色需要和效果图主色保持一致"],
      tips: ["优先保留玄关柜、衣柜等高频收纳", "开放格和复杂造型可减少，控制增项"],
    };
  }

  return {
    notes: ["灯具色温建议控制在 3000K 到 4000K", "窗帘轨道需提前和吊顶位置协调"],
    tips: ["灯具可以线上比价，自采更容易控制预算", "窗帘先确定遮光需求，再选面料和褶皱倍数"],
  };
}

function clampHydropowerPosition(value: number) {
  // 点位需要留出边缘安全距离，避免标记贴到图片边界后被裁切。
  return Math.max(8, Math.min(92, value));
}

function normalizeHydropowerRoomKind(space: PlanSpace) {
  // 户型解析返回的 type/name 可能是中文、英文或模型生成文本，这里统一做关键词归类。
  const rawName = `${space.type || ""} ${space.name || ""}`.toLowerCase();

  if (rawName.includes("厨") || rawName.includes("kitchen")) {
    return "kitchen";
  }

  if (rawName.includes("卫") || rawName.includes("bath") || rawName.includes("toilet") || rawName.includes("洗手间")) {
    return "bathroom";
  }

  if (rawName.includes("客") || rawName.includes("living")) {
    return "living";
  }

  if (rawName.includes("卧") || rawName.includes("bed") || rawName.includes("儿童房") || rawName.includes("老人房")) {
    return "bedroom";
  }

  if (rawName.includes("阳台") || rawName.includes("balcony")) {
    return "balcony";
  }

  if (rawName.includes("玄关") || rawName.includes("入户") || rawName.includes("走廊") || rawName.includes("过道")) {
    return "entry";
  }

  return "default";
}

function getHydropowerTemplatesForSpace(space: PlanSpace) {
  // 根据空间语义选择点位模板，保持“厨房/卫生间/卧室”等基础规则稳定。
  const roomKind = normalizeHydropowerRoomKind(space);

  return HYDROPOWER_TEMPLATES_BY_ROOM_KIND[roomKind] || HYDROPOWER_TEMPLATES_BY_ROOM_KIND.default;
}

function createHydropowerPointsForSpace(space: PlanSpace, spaceIndex: number) {
  // 当前没有真实户型坐标，所以先把每个空间落到一个网格锚点，再把该空间的点位围绕锚点错开。
  const roomName = space.name || `空间${spaceIndex + 1}`;
  const roomAnchor = HYDROPOWER_ROOM_ANCHORS[spaceIndex % HYDROPOWER_ROOM_ANCHORS.length];
  const templates = getHydropowerTemplatesForSpace(space);

  return templates.map((template, templateIndex) => {
    const pointOffset = HYDROPOWER_POINT_OFFSETS[templateIndex % HYDROPOWER_POINT_OFFSETS.length];

    return {
      id: `${spaceIndex}-${templateIndex}-${roomName}-${template.type}`,
      label: template.label,
      room: roomName,
      type: template.type,
      usage: template.usage,
      x: clampHydropowerPosition(roomAnchor.x + pointOffset.x),
      y: clampHydropowerPosition(roomAnchor.y + pointOffset.y),
    };
  });
}

function buildHydropowerPoints(floorPlan: PlanFloorPlan | null) {
  // 优先根据真实解析空间生成点位；没有解析结果时才使用兜底点位，保证页面仍可预览样式。
  const parsedSpaces = floorPlan?.spaces?.filter((space) => space.name) || [];

  if (!parsedSpaces.length) {
    return HYDROPOWER_FALLBACK_POINTS;
  }

  const generatedPoints = parsedSpaces.flatMap((space, spaceIndex) => createHydropowerPointsForSpace(space, spaceIndex));
  const hasStrongBox = generatedPoints.some((point) => point.type === "strongBox");
  const hasWeakBox = generatedPoints.some((point) => point.type === "weakBox");

  // 如果户型解析没有识别玄关，也需要给全屋保留强弱电箱建议点，避免水电图缺少入户核心点位。
  return [
    ...generatedPoints,
    ...(hasStrongBox
      ? []
      : [
          {
            id: "system-strong-box",
            label: "强电箱",
            room: "入户区",
            type: "strongBox" as const,
            usage: "全屋配电箱建议靠近入户区，最终位置以现场原始箱体为准",
            x: 14,
            y: 46,
          },
        ]),
    ...(hasWeakBox
      ? []
      : [
          {
            id: "system-weak-box",
            label: "弱电箱",
            room: "入户区",
            type: "weakBox" as const,
            usage: "网络、光猫和路由汇聚点，需预留电源和散热空间",
            x: 20,
            y: 46,
          },
        ]),
  ];
}

function getHydropowerRooms(floorPlan: PlanFloorPlan | null, points: HydropowerPoint[]) {
  // 房间下拉优先按户型解析顺序展示，额外补充系统生成的“入户区”等点位房间。
  const parsedRoomNames = floorPlan?.spaces?.map((space) => space.name).filter(Boolean) || [];
  const pointRoomNames = points.map((point) => point.room);

  return Array.from(new Set([...parsedRoomNames, ...pointRoomNames]));
}

function getHydropowerTypeConfig(type: HydropowerPointType) {
  return HYDROPOWER_TYPES.find((item) => item.id === type) || HYDROPOWER_TYPES[0];
}

function normalizeDesignAssetUrl(url: string | null | undefined) {
  // 户型图和效果图历史数据可能还是 /uploads/design-assets，前端展示时统一切到 API 读取。
  if (!url) {
    return "";
  }

  return url.startsWith("/uploads/design-assets/")
    ? url.replace("/uploads/design-assets/", "/api/design/assets/")
    : url;
}

export function PlanTabNav({
  activeTab,
  hasUploadedFloorPlan,
  onChange,
}: {
  activeTab: PlanTab;
  hasUploadedFloorPlan: boolean;
  onChange: (tab: PlanTab) => void;
}) {
  return (
    <div className="rounded-lg border border-[#d9e4f7] bg-white px-4 pt-3 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[#17233f]">装修方案</h2>
          <div className="mt-1 text-xs text-[#7d8aa6]">效果图、水电点位、方案预算和避坑提醒分开管理。</div>
        </div>
      </div>
      <div className="flex gap-6 overflow-x-auto border-t border-[#edf2fa] pt-3">
        {PLAN_TABS.map((tab) => {
          // 水电位图和方案预算依赖用户上传的真实户型图；未上传前禁用，避免展示兜底假数据。
          const lockedByFloorPlan = !hasUploadedFloorPlan && (tab.id === "hydropower" || tab.id === "budget");

          return (
            <button
              className={
                lockedByFloorPlan
                  ? "h-10 shrink-0 cursor-not-allowed px-1 text-sm font-semibold text-[#a8b4c8]"
                  : activeTab === tab.id
                    ? "relative h-10 shrink-0 px-1 text-sm font-semibold text-[#0969ff] after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-[#0969ff]"
                    : "h-10 shrink-0 px-1 text-sm font-semibold text-[#667799] transition hover:text-[#0969ff]"
              }
              disabled={lockedByFloorPlan}
              key={tab.id}
              onClick={() => onChange(tab.id)}
              title={lockedByFloorPlan ? "请先上传户型图" : undefined}
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PlanUploadRequiredPanel({ moduleName }: { moduleName: string }) {
  // 兜底拦截面板：即使外部状态异常切进水电位图/方案预算，也不会展示临时估算内容。
  return (
    <section className="grid min-h-[320px] place-items-center rounded-lg border border-dashed border-[#bfd1ee] bg-white p-8 text-center shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
      <div className="max-w-md">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-[#d9e4f7] bg-[#f8fbff] text-[#0969ff]">
          <svg aria-hidden="true" className="size-7" fill="none" viewBox="0 0 24 24">
            <path
              d="M4 19V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"
              stroke="currentColor"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
            <path d="M14 3v6h6M8 15h8M8 11h3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          </svg>
        </div>
        <h3 className="mt-5 text-lg font-semibold text-[#17233f]">请先上传户型图</h3>
        <p className="mt-3 text-sm leading-7 text-[#667799]">
          {moduleName} 必须基于真实户型图生成。请先在上方上传户型图，上传成功后系统会开放该模块。
        </p>
      </div>
    </section>
  );
}

export function HydropowerPlanPanel({ floorPlan }: { floorPlan: PlanFloorPlan | null }) {
  // selectedType 控制顶部点位类型筛选，默认展示全部，方便用户先看到完整水电布局。
  const [selectedType, setSelectedType] = useState<HydropowerPointType | "all">("all");
  // selectedRoom 控制房间筛选；房间列表来自户型解析结果和系统补充点位。
  const [selectedRoom, setSelectedRoom] = useState("all");
  // selectedPointId 记录用户当前点击的点位，右侧说明卡片会跟随它刷新。
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);

  // hydropowerPoints 是水电图的核心数据源：有户型解析就按空间生成，没有就用兜底样例。
  const hydropowerPoints = useMemo(() => buildHydropowerPoints(floorPlan), [floorPlan]);
  // roomOptions 用于房间下拉，保证“解析空间”和“系统补充点位房间”都能被筛选。
  const roomOptions = useMemo(() => getHydropowerRooms(floorPlan, hydropowerPoints), [floorPlan, hydropowerPoints]);
  // filteredPoints 是当前视图真正渲染到图上的点位集合。
  const filteredPoints = useMemo(
    () =>
      hydropowerPoints.filter((point) => {
        const matchType = selectedType === "all" || point.type === selectedType;
        const matchRoom = selectedRoom === "all" || point.room === selectedRoom;

        return matchType && matchRoom;
      }),
    [hydropowerPoints, selectedRoom, selectedType],
  );
  // selectedPoint 用于右侧“当前点位说明”，筛选后如果原点位不可见，会自动回到当前列表第一项。
  const selectedPoint = filteredPoints.find((point) => point.id === selectedPointId) || filteredPoints[0] || hydropowerPoints[0];
  const typeStats = HYDROPOWER_TYPES.filter((item) => item.id !== "all").map((item) => ({
    ...item,
    count: hydropowerPoints.filter((point) => point.type === item.id).length,
  }));
  const hasUploadedFloorPlan = Boolean(floorPlan?.file_url);
  const sourceLabel = floorPlan?.spaces?.length ? "已按解析空间生成点位" : "等待户型解析后自动匹配空间";

  return (
    <section className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-base font-semibold text-[#17233f]">
            <span className="grid size-7 place-items-center rounded-lg border border-[#d9e4f7] text-[#0969ff]">
              <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
                <path
                  d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"
                  stroke="currentColor"
                  strokeLinejoin="round"
                  strokeWidth="1.7"
                />
              </svg>
            </span>
            水电点位规划图
          </div>
          <div className="mt-1 text-xs leading-5 text-[#7d8aa6]">
            {sourceLabel}，施工前请与现场实际尺寸、原始配电箱和上下水位置核对。
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="rounded-full bg-[#eef6ff] px-2.5 py-1 text-xs font-semibold text-[#0969ff]">
              {hasUploadedFloorPlan ? "使用上传户型图底图" : "暂无上传底图"}
            </span>
            <span className="rounded-full bg-[#eef6ff] px-2.5 py-1 text-xs font-semibold text-[#48628c]">
              共 {hydropowerPoints.length} 个建议点位
            </span>
          </div>
        </div>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#d9e4f7] bg-white px-3 text-sm font-semibold text-[#42557d] transition hover:border-[#8eb8ff] hover:bg-[#eef6ff] hover:text-[#0969ff]"
          type="button"
        >
          <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
            <path
              d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
          </svg>
          编辑
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {HYDROPOWER_TYPES.map((item) => (
          <button
            className={
              selectedType === item.id
                ? "inline-flex h-10 items-center gap-2 rounded-lg border border-[#0969ff] bg-[#eef6ff] px-3 text-sm font-semibold text-[#0969ff]"
                : "inline-flex h-10 items-center gap-2 rounded-lg border border-[#d9e4f7] bg-white px-3 text-sm font-semibold text-[#42557d] transition hover:border-[#8eb8ff] hover:bg-[#eef6ff] hover:text-[#0969ff]"
            }
            key={item.id}
            onClick={() => {
              setSelectedType(item.id);
              setSelectedPointId(null);
            }}
            type="button"
          >
            <span className={`grid size-5 place-items-center rounded-full text-[10px] font-bold text-white ${item.colorClassName}`}>
              {item.shortLabel}
            </span>
            {item.label}
          </button>
        ))}
        <select
          aria-label="选择房间"
          className="ml-auto h-10 min-w-[180px] rounded-lg border border-[#d9e4f7] bg-white px-3 text-sm font-semibold text-[#42557d] outline-none transition focus:border-[#0969ff]"
          onChange={(event) => {
            setSelectedRoom(event.target.value);
            setSelectedPointId(null);
          }}
          value={selectedRoom}
        >
          <option value="all">全部房间</option>
          {roomOptions.map((roomName) => (
            <option key={roomName} value={roomName}>
              {roomName}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_270px]">
        <div className="rounded-lg border border-[#d9e4f7] bg-[#f8fbff] p-4">
          <div className="relative mx-auto aspect-[1.42] max-h-[560px] min-h-[420px] overflow-hidden rounded-lg border border-[#d9e4f7] bg-white shadow-inner">
            {floorPlan?.file_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                alt="户型图底图"
                className="absolute inset-0 h-full w-full object-contain opacity-70"
                src={normalizeDesignAssetUrl(floorPlan.file_url)}
              />
            ) : (
              <div className="absolute inset-6 grid grid-cols-4 grid-rows-3 gap-2 opacity-80">
                {HYDROPOWER_FALLBACK_ROOMS.map((room, index) => (
                  <div
                    className={
                      index === 5
                        ? "col-span-2 row-span-2 grid place-items-center rounded border-2 border-[#aebbd0] bg-white text-sm font-semibold text-[#7d8aa6]"
                        : "grid place-items-center rounded border border-[#cfd9ea] bg-white text-xs font-semibold text-[#8a98b2]"
                    }
                    key={room}
                  >
                    {room}
                  </div>
                ))}
              </div>
            )}

            <div className="absolute inset-0">
              {filteredPoints.map((point) => {
                const typeConfig = getHydropowerTypeConfig(point.type);
                const isSelected = selectedPoint?.id === point.id;

                return (
                  <button
                    aria-label={`${point.room}${point.label}`}
                    className={`absolute grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[10px] font-bold text-white shadow-[0_8px_18px_rgba(15,23,42,0.24)] ring-2 ring-white transition hover:z-10 hover:scale-110 ${isSelected ? "z-20 scale-110 ring-4 ring-[#17233f]" : ""} ${typeConfig.colorClassName}`}
                    key={point.id}
                    onClick={() => setSelectedPointId(point.id)}
                    style={{ left: `${point.x}%`, top: `${point.y}%` }}
                    type="button"
                  >
                    {typeConfig.shortLabel}
                  </button>
                );
              })}
            </div>

            {!filteredPoints.length ? (
              <div className="absolute inset-0 grid place-items-center bg-white/72 p-6 text-center backdrop-blur-sm">
                <div>
                  <div className="text-sm font-semibold text-[#17233f]">当前筛选下暂无点位</div>
                  <div className="mt-2 text-xs text-[#667799]">可以切换点位类型或房间查看其他规划建议。</div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="grid gap-3">
          <div className="rounded-lg border border-[#d9e4f7] bg-white p-4">
            <div className="text-sm font-semibold text-[#17233f]">图例与统计</div>
            <div className="mt-3 grid gap-2">
              {typeStats.map((item) => (
                <div className="flex items-center justify-between gap-3 text-sm" key={item.id}>
                  <div className="flex items-center gap-2 text-[#42557d]">
                    <span className={`grid size-5 place-items-center rounded-full text-[10px] font-bold text-white ${item.colorClassName}`}>
                      {item.shortLabel}
                    </span>
                    {item.label}
                  </div>
                  <span className="font-semibold text-[#17233f]">{item.count}个</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-[#d9e4f7] bg-white p-4">
            <div className="text-sm font-semibold text-[#17233f]">当前点位说明</div>
            {selectedPoint ? (
              <div className="mt-3 grid gap-2 text-xs leading-5 text-[#667799]">
                <div>
                  <span className="font-semibold text-[#42557d]">类型：</span>
                  {getHydropowerTypeConfig(selectedPoint.type).label}（{selectedPoint.label}）
                </div>
                <div>
                  <span className="font-semibold text-[#42557d]">所在房间：</span>
                  {selectedPoint.room}
                </div>
                <div>
                  <span className="font-semibold text-[#42557d]">图上位置：</span>
                  横向 {Math.round(selectedPoint.x)}%，纵向 {Math.round(selectedPoint.y)}%
                </div>
                <div>
                  <span className="font-semibold text-[#42557d]">用途说明：</span>
                  {selectedPoint.usage}
                </div>
              </div>
            ) : (
              <div className="mt-3 text-xs leading-5 text-[#667799]">
                暂无可展示点位，请先上传并解析户型图，或切换筛选条件。
              </div>
            )}
          </div>

          <div className="rounded-lg border border-[#d9e4f7] bg-white p-4">
            <div className="text-sm font-semibold text-[#17233f]">使用提示</div>
            <div className="mt-3 space-y-1 text-xs leading-5 text-[#667799]">
              <div>- 本图为规划建议，仅供参考</div>
              <div>- 施工前请与现场核对尺寸及点位</div>
              <div>- 如有调整，请进入编辑模式修改</div>
              <div>- 点位高度以施工图纸为准</div>
            </div>
          </div>

          <div className="rounded-lg border border-[#d9e4f7] bg-[#f8fbff] p-3 text-xs leading-5 text-[#667799]">
            当前空间：{selectedRoom === "all" ? getSpaceNames(floorPlan) : selectedRoom}
          </div>
        </aside>
      </div>
    </section>
  );
}

function BudgetLaborDetailTable({ rows }: { rows: BudgetLaborDetail[] }) {
  // 人工费展开表模拟可编辑报价单样式，当前输入框只读，后续接预算编辑时再开放修改。
  // subtotal 是展开人工明细合计，必须和主表 row.labor 保持一致。
  const subtotal = rows.reduce((sum, row) => sum + row.subtotal, 0);

  return (
    <div className="rounded-lg border border-[#d9e4f7] bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-[#17233f]">人工费</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[360px] border-collapse text-xs">
          <thead className="bg-[#fbfdff] text-[#42557d]">
            <tr>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-left">工种</th>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-center">人工单价（元）</th>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-center">工时（日）</th>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-right">人工费（元）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="text-[#17233f]" key={row.trade}>
                <td className="border-b border-[#edf2fa] px-2 py-2 font-medium">{row.trade}</td>
                <td className="border-b border-[#edf2fa] px-2 py-2 text-center">
                  <input
                    aria-label={`${row.trade}人工单价`}
                    className="h-8 w-20 rounded-md border border-[#d9e4f7] bg-[#fbfdff] px-2 text-center font-semibold outline-none"
                    readOnly
                    value={row.unitPrice}
                  />
                </td>
                <td className="border-b border-[#edf2fa] px-2 py-2 text-center font-medium">{row.days}</td>
                <td className="border-b border-[#edf2fa] px-2 py-2 text-right font-semibold">{formatBudgetNumber(row.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex justify-between border-t border-[#edf2fa] pt-3 text-sm font-semibold text-[#17233f]">
        <span>人工费小计</span>
        <span>{formatBudgetNumber(subtotal)}</span>
      </div>
    </div>
  );
}

function BudgetMaterialDetailTable({ rows }: { rows: BudgetMaterialDetail[] }) {
  // 材料费展开表展示规格、用量、单价和采购方式，方便用户判断哪些能自采省钱。
  // subtotal 是展开材料明细合计，必须和主表 row.material 保持一致。
  const subtotal = rows.reduce((sum, row) => sum + row.subtotal, 0);

  return (
    <div className="rounded-lg border border-[#d9e4f7] bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-[#17233f]">材料费</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-xs">
          <thead className="bg-[#fbfdff] text-[#42557d]">
            <tr>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-left">材料</th>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-left">规格型号</th>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-center">用量</th>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-center">单价（元）</th>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-right">小计（元）</th>
              <th className="border-b border-[#e8eef7] px-2 py-2 text-center">采购方式</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="text-[#17233f]" key={`${row.name}-${row.spec}`}>
                <td className="border-b border-[#edf2fa] px-2 py-2 font-medium">{row.name}</td>
                <td className="border-b border-[#edf2fa] px-2 py-2 text-[#42557d]">{row.spec}</td>
                <td className="border-b border-[#edf2fa] px-2 py-2 text-center font-medium">{row.quantity}</td>
                <td className="border-b border-[#edf2fa] px-2 py-2 text-center">
                  <input
                    aria-label={`${row.name}材料单价`}
                    className="h-8 w-20 rounded-md border border-[#d9e4f7] bg-[#fbfdff] px-2 text-center font-semibold outline-none"
                    readOnly
                    value={row.unitPrice}
                  />
                </td>
                <td className="border-b border-[#edf2fa] px-2 py-2 text-right font-semibold">{formatBudgetNumber(row.subtotal)}</td>
                <td className="border-b border-[#edf2fa] px-2 py-2 text-center">
                  <select
                    aria-label={`${row.name}采购方式`}
                    className="h-8 rounded-md border border-[#d9e4f7] bg-[#fbfdff] px-2 text-xs font-semibold text-[#42557d] outline-none"
                    value={row.procurement}
                    disabled
                  >
                    <option>装修公司提供</option>
                    <option>自采</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex justify-between border-t border-[#edf2fa] pt-3 text-sm font-semibold text-[#17233f]">
        <span>材料费小计</span>
        <span>{formatBudgetNumber(subtotal)}</span>
      </div>
    </div>
  );
}

function BudgetSavingAdviceCard({ advice }: { advice: BudgetSavingAdvice }) {
  // 省钱建议只给预算策略，不把估算包装成合同结论。
  return (
    <div className="flex min-h-full flex-col rounded-lg border border-[#d9e4f7] bg-white p-4">
      <div className="text-sm font-semibold text-[#17233f]">{advice.title}</div>
      <div className="mt-4 text-sm leading-7 text-[#42557d]">{advice.content}</div>
      <div className="mt-auto pt-5">
        <div className="text-sm font-semibold text-[#42557d]">可节省</div>
        <div className={advice.saving > 0 ? "mt-2 text-2xl font-bold text-[#16a34a]" : "mt-2 text-lg font-bold text-[#42557d]"}>
          {advice.saving > 0 ? `${formatBudgetNumber(advice.saving)} 元` : "不建议压缩"}
        </div>
        <button
          className="mt-5 h-10 w-full rounded-lg bg-[#0969ff] text-sm font-semibold text-white shadow-[0_10px_22px_rgba(9,105,255,0.22)] transition hover:bg-[#005bed]"
          type="button"
        >
          应用省钱方案
        </button>
      </div>
    </div>
  );
}

function BudgetSoftExpandedDetail({ detail }: { detail: BudgetSoftDetail }) {
  // 软装家电的展开区参考选购清单样式，重点提示采购策略和尺寸复核。
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-lg border border-[#d9e4f7] bg-white p-4">
        <div className="text-sm font-semibold text-[#17233f]">选购建议</div>
        <div className="mt-3 space-y-2 text-sm leading-6 text-[#42557d]">
          {detail.tips.map((tip) => (
            <div key={tip}>- {tip}</div>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-[#d9e4f7] bg-white p-4">
        <div className="text-sm font-semibold text-[#17233f]">备注</div>
        <div className="mt-3 space-y-2 text-sm leading-6 text-[#42557d]">
          {detail.notes.map((note) => (
            <div key={note}>- {note}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BudgetExpandedDetail({ row, view }: { row: BudgetRow; view: BudgetView }) {
  // 展开区根据当前 Tab 切换不同明细模板，避免软装家电被硬拆成人工费和材料费。
  if (view === "soft") {
    return <BudgetSoftExpandedDetail detail={getBudgetSoftDetail(row)} />;
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.8fr)_minmax(480px,1.25fr)_310px]">
      <BudgetLaborDetailTable rows={getBudgetLaborDetails(row, view)} />
      <BudgetMaterialDetailTable rows={getBudgetMaterialDetails(row, view)} />
      <BudgetSavingAdviceCard advice={getBudgetSavingAdvice(row, view)} />
    </div>
  );
}

export function BudgetPlanPanel({
  floorPlan,
  preferences,
  hasRender,
}: {
  floorPlan: PlanFloorPlan | null;
  preferences: PlanPreferences;
  hasRender: boolean;
}) {
  // activeBudgetView 控制预算明细表的查看维度，默认按空间展示，贴近用户看装修报价的习惯。
  const [activeBudgetView, setActiveBudgetView] = useState<BudgetView>("space");
  // expandedBudgetRowId 控制哪一行展开明细；一次只展开一行，避免表格变得过长。
  const [expandedBudgetRowId, setExpandedBudgetRowId] = useState<string | null>(null);
  // budgetArea 是预算计算面积。真实面积未解析时用临时面积兜底，页面不会空白。
  const budgetArea = getBudgetArea(floorPlan);
  // quoteLevel 把用户选择的中文预算倾向转换成内部档位，便于统一查单价和材料策略。
  const quoteLevel = mapBudgetToQuoteLevel(preferences.budget);
  // budgetRange 是顶部“总预算区间”和“城市参考价”的数据来源。
  const budgetRange = getBudgetRange(budgetArea.area, quoteLevel);
  // recommendedBudget 是所有明细拆分的基准预算，按区间中位数计算。
  const recommendedBudget = budgetRange?.recommended || 0;
  // adjustedBudget 用于展示用户偏好调整后的预算结果，后续可替换为真实预算编辑器输出。
  const adjustedBudget = getBudgetAdjustedValue(recommendedBudget, preferences);
  // materials 当前用于解释预算档位对应的材料策略，后续会替换成真实材料清单。
  const materials = MATERIAL_STRATEGY[quoteLevel] || MATERIAL_STRATEGY.standard;
  // budgetRows 是表格唯一数据源，切换 Tab 时只替换 rows，不改表格结构。
  const budgetRows = getBudgetRows(activeBudgetView, floorPlan, recommendedBudget, materials);
  // firstColumnLabel 让同一张表在不同 Tab 下显示“空间/工程项/软装家电”。
  const firstColumnLabel = getBudgetFirstColumnLabel(activeBudgetView);
  // totalRowBudget 用来校验当前维度合计，避免用户误解切换维度后金额含义。
  const totalRowBudget = budgetRows.reduce((sum, row) => sum + row.total, 0);

  return (
    <section className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
      <div className="grid gap-3 lg:grid-cols-4">
        <div className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_24px_rgba(22,56,117,0.04)]">
          <div className="text-sm font-semibold text-[#17233f]">总预算区间</div>
          <div className="mt-4 text-xl font-bold text-[#17233f]">
            {budgetRange ? `${formatMoney(budgetRange.min)} ~ ${formatMoney(budgetRange.max)}` : "待面积解析"}
          </div>
          <div className="mt-3 text-xs leading-5 text-[#7d8aa6]">
            {budgetArea.estimated ? "面积未解析，当前按 100㎡ 临时预估" : "包含硬装 + 主材 + 软装家电 + 税费"}
          </div>
        </div>

        <div className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_24px_rgba(22,56,117,0.04)]">
          <div className="text-sm font-semibold text-[#17233f]">推荐预算值</div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xl font-bold text-[#17233f]">{formatMoney(recommendedBudget)}</span>
            <span className="rounded-full bg-[#e8f8ef] px-2 py-1 text-xs font-semibold text-[#13875a]">
              {BUDGET_LEVEL_LABEL[quoteLevel]}
            </span>
          </div>
          <div className="mt-3 text-xs leading-5 text-[#7d8aa6]">不含家具定制，个性化改造另计</div>
        </div>

        <div className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_24px_rgba(22,56,117,0.04)]">
          <div className="text-sm font-semibold text-[#17233f]">自定义调整后</div>
          <div className="mt-4 text-xl font-bold text-[#17233f]">{formatMoney(adjustedBudget)}</div>
          <div className="mt-3 text-xs leading-5 text-[#7d8aa6]">
            根据您的预算倾向和重点实时更新
          </div>
        </div>

        <div className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_24px_rgba(22,56,117,0.04)]">
          <div className="text-sm font-semibold text-[#17233f]">城市参考价（北京）</div>
          <div className="mt-4 text-xl font-bold text-[#0969ff]">
            ¥ {budgetRange?.unitMin.toLocaleString("zh-CN")} ~ {budgetRange?.unitMax.toLocaleString("zh-CN")}
            <span className="ml-1 text-sm font-semibold text-[#17233f]">/㎡</span>
          </div>
          <div className="mt-3 flex items-center gap-1 text-xs leading-5 text-[#7d8aa6]">
            <span>参考来源：沿价行政区成交价</span>
            <span className="grid size-4 place-items-center rounded-full border border-[#b8c7df] text-[10px] text-[#7d8aa6]">i</span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-[#d9e4f7] bg-[#f5f9ff] px-3 py-2 text-xs leading-5 text-[#42557d]">
        <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-[#0969ff] text-[10px] font-semibold text-white">
          i
        </span>
        <span>
          {hasRender
            ? "在当前预算区间内，优先保障水电、防水、五金等关键质量项，装饰性费用将合理优化。"
            : "效果图生成前先给出预算框架；生成效果图后可继续按风格材料细化报价。"}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-7 overflow-x-auto">
          {BUDGET_VIEW_TABS.map((tab) => (
            <button
              className={
                activeBudgetView === tab.id
                  ? "relative h-10 shrink-0 px-1 text-sm font-semibold text-[#0969ff] after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-[#0969ff]"
                  : "h-10 shrink-0 px-1 text-sm font-semibold text-[#42557d] transition hover:text-[#0969ff]"
              }
              key={tab.id}
              onClick={() => {
                setActiveBudgetView(tab.id);
                setExpandedBudgetRowId(null);
              }}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          className="h-9 rounded-lg bg-[#0969ff] px-4 text-sm font-semibold text-white shadow-[0_10px_22px_rgba(9,105,255,0.22)] transition hover:bg-[#005bed]"
          type="button"
        >
          保存调整
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-[#e2eaf6]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead className="bg-[#fbfdff] text-xs font-semibold text-[#17233f]">
              {activeBudgetView === "soft" ? (
                // 软装家电不是施工项，因此表头展示预算、数量、均价和采购方式。
                <tr>
                  <th className="w-[180px] border-b border-r border-[#e8eef7] px-4 py-3 text-left">品类</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">预算（元）</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">占比</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">数量</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">单价（元）</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">采购方式</th>
                  <th className="border-b border-[#e8eef7] px-4 py-3 text-center">操作</th>
                </tr>
              ) : (
                // 按空间和按工程项都是施工预算视角，因此保留人工费、材料费和预算建议。
                <tr>
                  <th className="w-[150px] border-b border-r border-[#e8eef7] px-4 py-3 text-left">{firstColumnLabel}</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">总预算（元）</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">人工费（元）</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">材料费（元）</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">占比</th>
                  <th className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">预算建议</th>
                  <th className="border-b border-[#e8eef7] px-4 py-3 text-center">操作</th>
                </tr>
              )}
            </thead>
            <tbody>
              {budgetRows.map((row) => {
                const expanded = expandedBudgetRowId === row.id;

                return (
                  <Fragment key={row.id}>
                    {activeBudgetView === "soft" ? (
                      // 软装主行按品类聚合，不展示人工费，避免用户误以为软装也有施工人工拆分。
                      <tr className={expanded ? "bg-[#fbfdff] text-[#17233f]" : "bg-white text-[#17233f] transition hover:bg-[#f8fbff]"}>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span
                              className={`relative size-10 shrink-0 overflow-hidden rounded-lg border border-[#d9e4f7] ${getBudgetThumbnailClassName(row.thumbnailTone)}`}
                            >
                              <span className="absolute bottom-1 left-1 h-2 w-6 rounded-full bg-white/50" />
                              <span className="absolute right-1 top-1 h-5 w-2 rounded-sm bg-black/12" />
                            </span>
                            <span className="font-semibold">{row.name}</span>
                          </div>
                        </td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3 text-center font-semibold">
                          {formatBudgetNumber(row.total)}
                        </td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3 text-center font-semibold">{row.ratio}%</td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3 text-center font-semibold">{getBudgetSoftQuantity(row)}</td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3 text-center font-semibold">
                          {formatBudgetNumber(getBudgetSoftUnitPrice(row))}
                        </td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3 text-center font-semibold">自采</td>
                        <td className="border-b border-[#e8eef7] px-4 py-3 text-center">
                          <button
                            className="inline-flex items-center gap-2 text-sm font-semibold text-[#0969ff]"
                            onClick={() => setExpandedBudgetRowId(expanded ? null : row.id)}
                            type="button"
                          >
                            {expanded ? "收起" : "展开"}
                            <svg
                              aria-hidden="true"
                              className={expanded ? "size-4 rotate-180 transition" : "size-4 transition"}
                              fill="none"
                              viewBox="0 0 24 24"
                            >
                              <path d="m6 9 6 6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ) : (
                      // 施工预算主行展示汇总金额，真正的人工/材料明细放到下方展开区。
                      <tr className={expanded ? "bg-[#fbfdff] text-[#17233f]" : "bg-white text-[#17233f] transition hover:bg-[#f8fbff]"}>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span
                              className={`relative size-10 shrink-0 overflow-hidden rounded-lg border border-[#d9e4f7] ${getBudgetThumbnailClassName(row.thumbnailTone)}`}
                            >
                              <span className="absolute bottom-1 left-1 h-2 w-6 rounded-full bg-white/50" />
                              <span className="absolute right-1 top-1 h-5 w-2 rounded-sm bg-black/12" />
                            </span>
                            <span className="font-semibold">{row.name}</span>
                          </div>
                        </td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3 text-center font-semibold">
                          {formatBudgetNumber(row.total)}
                        </td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3 text-center font-semibold">
                          {formatBudgetNumber(row.labor)}
                        </td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3 text-center font-semibold">
                          {formatBudgetNumber(row.material)}
                        </td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3">
                          <div className="flex items-center justify-center gap-3">
                            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-[#e2e8f0]">
                              <span
                                className="block h-full rounded-full bg-[#0969ff]"
                                style={{ width: `${Math.min(100, Math.max(4, row.ratio))}%` }}
                              />
                            </span>
                            <span className="w-10 text-right font-medium text-[#42557d]">{row.ratio}%</span>
                          </div>
                        </td>
                        <td className="border-b border-r border-[#e8eef7] px-4 py-3 text-center">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${getBudgetAdviceClassName(row.adviceTone)}`}>
                            {row.advice}
                          </span>
                        </td>
                        <td className="border-b border-[#e8eef7] px-4 py-3 text-center">
                          <button
                            className="inline-flex items-center gap-2 text-sm font-semibold text-[#0969ff]"
                            onClick={() => setExpandedBudgetRowId(expanded ? null : row.id)}
                            type="button"
                          >
                            {expanded ? "收起" : "展开"}
                            <svg
                              aria-hidden="true"
                              className={expanded ? "size-4 rotate-180 transition" : "size-4 transition"}
                              fill="none"
                              viewBox="0 0 24 24"
                            >
                              <path d="m6 9 6 6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    )}
                    {expanded ? (
                      // 展开区根据当前 Tab 选择不同组件：施工预算显示人工/材料/省钱建议，软装显示选购建议/备注。
                      <tr>
                        <td className="border-b border-[#e8eef7] bg-[#f8fbff] p-3" colSpan={7}>
                          <BudgetExpandedDetail row={row} view={activeBudgetView} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-[#7d8aa6]">
        <span>
          当前维度合计：{formatMoney(totalRowBudget)}，材料策略：{materials.join("、")}
        </span>
        <span>最终报价以现场复尺、施工图和材料清单确认为准。</span>
      </div>
    </section>
  );
}

export function RiskReminderPanel({
  circulationSummary,
  areaSummary,
  doorsCount,
  windowsCount,
  structureRiskWarnings,
  circulationIssues,
  potentialWaste,
  areaSuggestions,
}: {
  circulationSummary: string;
  areaSummary: string;
  doorsCount: number;
  windowsCount: number;
  structureRiskWarnings: string[];
  circulationIssues: string[];
  potentialWaste: string[];
  areaSuggestions: string[];
}) {
  return (
    <section className="rounded-lg border border-[#d9e4f7] bg-white p-4 shadow-[0_10px_30px_rgba(22,56,117,0.06)]">
      <div className="mb-4">
        <div className="text-base font-semibold text-[#17233f]">避坑提醒</div>
        <div className="mt-1 text-xs text-[#7d8aa6]">基于户型解析结果展示动线、面积、门窗、采光和结构边界信息。</div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-[#d9e4f7] bg-[#f8fbff] p-3">
          <div className="text-xs font-semibold text-[#0969ff]">动线</div>
          <div className="mt-2 text-sm leading-6 text-[#17233f]">{circulationSummary}</div>
          {circulationIssues.length ? (
            <div className="mt-2 space-y-1 text-xs leading-5 text-[#667799]">
              {circulationIssues.slice(0, 2).map((issue) => (
                <div key={issue}>- {issue}</div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-[#d9e4f7] bg-[#f8fbff] p-3">
          <div className="text-xs font-semibold text-[#0969ff]">面积</div>
          <div className="mt-2 text-sm leading-6 text-[#17233f]">{areaSummary}</div>
          {potentialWaste.length ? (
            <div className="mt-2 space-y-1 text-xs leading-5 text-[#667799]">
              {potentialWaste.slice(0, 2).map((item) => (
                <div key={item}>- {item}</div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-[#d9e4f7] bg-[#f8fbff] p-3">
          <div className="text-xs font-semibold text-[#0969ff]">门窗采光</div>
          <div className="mt-2 text-sm leading-6 text-[#17233f]">{doorsCount} 个门位，{windowsCount} 个窗位</div>
          <div className="mt-2 text-xs leading-5 text-[#667799]">后续结合水电点位图继续校验采光和开关插座位置。</div>
        </div>

        <div className="rounded-lg border border-[#d9e4f7] bg-[#fffafb] p-3">
          <div className="text-xs font-semibold text-[#ef3349]">结构边界</div>
          <div className="mt-2 text-sm leading-6 text-[#17233f]">{structureRiskWarnings[0] || "承重墙、梁柱需结构图确认"}</div>
          <div className="mt-2 text-xs leading-5 text-[#667799]">AI 仅做疑似识别，不能替代物业审批和专业结构判断。</div>
        </div>
      </div>

      {areaSuggestions.length ? (
        <div className="mt-3 rounded-lg border border-[#d9e4f7] bg-white p-3">
          <div className="text-xs font-semibold text-[#42557d]">优化建议</div>
          <div className="mt-2 grid gap-2 text-xs leading-5 text-[#667799] md:grid-cols-2">
            {areaSuggestions.slice(0, 4).map((suggestion) => (
              <div className="rounded-md bg-[#f8fbff] px-3 py-2" key={suggestion}>
                {suggestion}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
