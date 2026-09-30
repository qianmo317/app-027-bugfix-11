/** 内部统一单位：毫米 mm（浮点保留 3 位小数） */
export type Pt = { x: number; y: number }

export type ContourWarning =
  | 'not_closed'
  | 'self_intersect'
  | 'duplicate'
  | 'offset_clipped'
  | 'offset_failed'
  | 'bridge_degraded'
  | 'too_short'

/** 连刀点：atIndex 为锚点在 points 中的顶点下标，widthMm 为缺口宽度 */
export type Bridge = { atIndex: number; widthMm: number }

export type Contour = {
  id: string
  points: Pt[]
  closed: boolean
  /** 派分值：面积（mm²），闭合轮廓的净面积 */
  area: number
  /** 派分值：周长（mm） */
  length: number
  /** 直接子轮廓（内层）id */
  holes: string[]
  bridges: Bridge[]
  warnings: ContourWarning[]
}

export type Shape = { id: string; name: string; contours: Contour[]; layer: number }

export type MaterialPreset = {
  id: string
  name: string
  paper: string
  force: number
  speedMmS: number
  passes: number
  bladeOffsetMm: number
  /** 垫板 */
  backing: string
}

export type CutSettings = {
  order: 'inner_first'
  bridgeRule: 'by_area' | 'by_length' | 'manual'
  areaThresholdMm2: number
  bridgeWidthMm: number
  bridgeEveryMm: number
  travelOptimize: 'nearest' | 'nearest_2opt'
  /** 贝塞尔离散化容差（mm） */
  toleranceMm: number
  /** 闭合判定容差（mm） */
  closeToleranceMm: number
  /** 是否启用刀补偏置 */
  useBladeOffset: boolean
}

export type ExportCfg = {
  format: 'plt' | 'gcode' | 'svg'
  unit: 'mm' | '0.025mm'
  origin: 'bottom_left' | 'top_left'
  yFlip: boolean
  scale: number
}

export type Sheet = { widthMm: number; heightMm: number; name: string }

/** 项目（保存到本地存储） */
export type Project = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  shapes: Shape[]
  settings: CutSettings
  export: ExportCfg
  sheet: Sheet
  materialId: string
  /** 图层名（多色纸分层切割） */
  layerNames: string[]
  /** 批量排版配置 */
  batch?: BatchCfg
  /** 批量排版的对象形状（同一纹样排满一张纸） */
  batchShapeId?: string
}

export type BatchCfg = {
  enabled: boolean
  rows: number
  cols: number
  gapXMm: number
  gapYMm: number
  /** 共边裁切：间距为 0 时相邻轮廓共边，重叠路径只切一次 */
  sharedEdge: boolean
  mode: 'repeat' | 'four_way'
}

export const DEFAULT_CUT_SETTINGS: CutSettings = {
  order: 'inner_first',
  bridgeRule: 'by_area',
  areaThresholdMm2: 4,
  bridgeWidthMm: 0.5,
  bridgeEveryMm: 12,
  travelOptimize: 'nearest_2opt',
  toleranceMm: 0.15,
  closeToleranceMm: 0.2,
  useBladeOffset: false,
}

export const DEFAULT_EXPORT_CFG: ExportCfg = {
  format: 'plt',
  unit: '0.025mm',
  origin: 'bottom_left',
  yFlip: true,
  scale: 1,
}

export const DEFAULT_SHEET: Sheet = { widthMm: 210, heightMm: 297, name: 'A4 纵向' }

export const A4_LANDSCAPE: Sheet = { widthMm: 297, heightMm: 210, name: 'A4 横向' }
export const SHEET_PRESETS: Sheet[] = [
  DEFAULT_SHEET,
  A4_LANDSCAPE,
  { widthMm: 300, heightMm: 300, name: '300×300 方纸' },
  { widthMm: 400, heightMm: 600, name: '400×600 宣纸' },
  { widthMm: 600, heightMm: 600, name: '600×600 大字纸' },
]

/** 纸张 / 材料（材料参数卡用） */
export type PaperKind = {
  paper: string
  label: string
  force: number
  speedMmS: number
  passes: number
  backing: string
  note: string
}

export const PAPER_KINDS: PaperKind[] = [
  {
    paper: 'cardstock',
    label: '卡纸',
    force: 120,
    speedMmS: 40,
    passes: 1,
    backing: '蓝色中硬垫板',
    note: '白卡 / 黑卡 200~300g，垫板硬度中等',
  },
  { paper: 'xuan', label: '宣纸', force: 60, speedMmS: 60, passes: 2, backing: '白色软垫板', note: '宣纸脆薄，多次轻切优于一次重切' },
  { paper: 'sticker', label: '不干胶', force: 90, speedMmS: 55, passes: 1, backing: '不粘垫板', note: '仅切穿面纸，勿伤底纸' },
  { paper: 'flock', label: '植绒', force: 150, speedMmS: 25, passes: 2, backing: '硬质垫板', note: '绒毛纤维阻力大，刀压高、速度慢' },
  { paper: 'kraft', label: '牛皮纸', force: 110, speedMmS: 45, passes: 1, backing: '蓝色中硬垫板', note: '常规包装打样' },
  {
    paper: 'red-paper',
    label: '红纸（剪纸）',
    force: 85,
    speedMmS: 50,
    passes: 1,
    backing: '白色软垫板',
    note: '非遗剪纸常用，注意连刀点宽度',
  },
]