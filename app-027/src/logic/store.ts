import { reactive } from 'vue'
import {
  DEFAULT_CUT_SETTINGS,
  DEFAULT_EXPORT_CFG,
  DEFAULT_SHEET,
  type BatchCfg,
  type Bridge,
  type Contour,
  type ContourWarning,
  type CutSettings,
  type ExportCfg,
  type MaterialPreset,
  type Project,
  type Shape,
  type Sheet,
} from './types'
import { computeShape, shapeSignature, type ComputedShape } from './pipeline'
import { buildBatchShape, buildJob, type Job } from './job'
import { dist, polygonArea, polylineLength, round3, uid } from './geometry'
import { importSvgText, type ImportResult } from './importer'
import { defaultMaterials } from '@/data/materials'

const LS_KEY = 'papercut-plotter-studio/v1'

type Persisted = {
  version: number
  projects?: Project[]
  materials?: MaterialPreset[]
}

type StoreState = {
  projects: Project[]
  materials: MaterialPreset[]
  ready: boolean
  lastError: string | null
}

export const state = reactive<StoreState>({
  projects: [],
  materials: [],
  ready: false,
  lastError: null,
})

/** 派生计算结果缓存（按几何签名失效，不持久化） */
const computedCache = reactive<Record<string, ComputedShape>>({})
const batchCache = new Map<string, ComputedShape>()

const VALID_WARNINGS: ContourWarning[] = [
  'not_closed',
  'self_intersect',
  'duplicate',
  'offset_clipped',
  'offset_failed',
  'bridge_degraded',
  'too_short',
]

const DEFAULT_BATCH: BatchCfg = { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' }

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function numOr(v: unknown, fallback: number): number {
  return isNum(v) ? (v as number) : fallback
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

// ---------------- 旧数据兼容：缺什么补什么 ----------------

function normalizeBridge(raw: unknown, fallbackWidth: number): Bridge {
  const b = (raw ?? {}) as Record<string, unknown>
  return {
    atIndex: Math.max(0, Math.trunc(numOr((b as { atIndex?: unknown }).atIndex, 0))),
    widthMm: numOr((b as { widthMm?: unknown }).widthMm, fallbackWidth),
  }
}

function normalizeContour(raw: unknown): Contour {
  const c = (raw ?? {}) as Record<string, unknown>
  const rawPts = Array.isArray(c.points) ? c.points : []
  let points = rawPts
    .map((q) => {
      const p = (q ?? {}) as Record<string, unknown>
      return { x: round3(numOr(p.x, 0)), y: round3(numOr(p.y, 0)) }
    })
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  const rawWarnings = Array.isArray(c.warnings) ? c.warnings : []
  const hadNotClosed = rawWarnings.includes('not_closed')
  // 旧数据没有 closed 标记：≥3 点且没标过 not_closed 的视为闭合
  const closedMissing = c.closed === undefined || typeof c.closed !== 'boolean'
  let closed = c.closed === true || (closedMissing && points.length >= 3 && !hadNotClosed)
  // 首尾点重复（导入器风格）时去掉冗余末点
  if (closed && points.length >= 4 && dist(points[0], points[points.length - 1]) <= 1e-6) {
    points = points.slice(0, -1)
  }
  const warnings = rawWarnings.filter((w): w is ContourWarning =>
    VALID_WARNINGS.includes(w as ContourWarning),
  )
  const bridges = Array.isArray(c.bridges)
    ? c.bridges.map((b) => normalizeBridge(b, DEFAULT_CUT_SETTINGS.bridgeWidthMm))
    : []
  return {
    id: strOr(c.id, uid('c')),
    points,
    closed,
    // 面积 / 周长是派分值：旧数据没有或不对时按点重算
    area: isNum(c.area) && closed ? c.area : closed ? polygonArea(points) : 0,
    length: isNum(c.length) ? c.length : polylineLength(points, closed),
    // holes 是包含树派分值，加载后由 recompute 重建
    holes: Array.isArray(c.holes) ? (c.holes.filter((h) => typeof h === 'string') as string[]) : [],
    bridges,
    warnings,
  }
}

function normalizeShape(raw: unknown, idx: number): Shape {
  const s = (raw ?? {}) as Record<string, unknown>
  return {
    id: strOr(s.id, uid('s')),
    name: strOr(s.name, `形状 ${idx + 1}`),
    contours: Array.isArray(s.contours) ? s.contours.map((c) => normalizeContour(c)) : [],
    layer: Math.max(0, Math.trunc(numOr(s.layer, 0))),
  }
}

function normalizeSettings(raw: unknown): CutSettings {
  const s = (raw ?? {}) as Partial<CutSettings>
  const out: CutSettings = { ...DEFAULT_CUT_SETTINGS, ...(typeof raw === 'object' && raw ? raw : {}) }
  out.order = 'inner_first'
  out.bridgeRule = s.bridgeRule === 'by_length' || s.bridgeRule === 'manual' ? s.bridgeRule : 'by_area'
  out.travelOptimize = s.travelOptimize === 'nearest' ? 'nearest' : 'nearest_2opt'
  out.areaThresholdMm2 = numOr(s.areaThresholdMm2, DEFAULT_CUT_SETTINGS.areaThresholdMm2)
  out.bridgeWidthMm = numOr(s.bridgeWidthMm, DEFAULT_CUT_SETTINGS.bridgeWidthMm)
  out.bridgeEveryMm = numOr(s.bridgeEveryMm, DEFAULT_CUT_SETTINGS.bridgeEveryMm)
  out.toleranceMm = numOr(s.toleranceMm, DEFAULT_CUT_SETTINGS.toleranceMm)
  out.closeToleranceMm = numOr(s.closeToleranceMm, DEFAULT_CUT_SETTINGS.closeToleranceMm)
  out.useBladeOffset = s.useBladeOffset === true
  return out
}

function normalizeExport(raw: unknown): ExportCfg {
  const e = (raw ?? {}) as Partial<ExportCfg>
  return {
    format: e.format === 'gcode' || e.format === 'svg' ? e.format : 'plt',
    unit: e.unit === 'mm' ? 'mm' : '0.025mm',
    origin: e.origin === 'top_left' ? 'top_left' : 'bottom_left',
    yFlip: e.yFlip !== false,
    scale: numOr(e.scale, 1),
  }
}

function normalizeSheet(raw: unknown): Sheet {
  const s = (raw ?? {}) as Partial<Sheet>
  return {
    widthMm: numOr(s.widthMm, DEFAULT_SHEET.widthMm),
    heightMm: numOr(s.heightMm, DEFAULT_SHEET.heightMm),
    name: strOr(s.name, DEFAULT_SHEET.name),
  }
}

function normalizeBatch(raw: unknown): BatchCfg {
  const b = (raw ?? {}) as Partial<BatchCfg>
  return {
    enabled: b.enabled === true,
    rows: Math.max(1, Math.round(numOr(b.rows, DEFAULT_BATCH.rows))),
    cols: Math.max(1, Math.round(numOr(b.cols, DEFAULT_BATCH.cols))),
    gapXMm: Math.max(0, numOr(b.gapXMm, DEFAULT_BATCH.gapXMm)),
    gapYMm: Math.max(0, numOr(b.gapYMm, DEFAULT_BATCH.gapYMm)),
    sharedEdge: b.sharedEdge === true,
    mode: b.mode === 'four_way' ? 'four_way' : 'repeat',
  }
}

export function normalizeProject(raw: unknown): Project {
  const p = (raw ?? {}) as Record<string, unknown>
  const now = Date.now()
  const createdAt = numOr(p.createdAt, now)
  const settings = normalizeSettings(p.settings)
  const shapes = Array.isArray(p.shapes)
    ? p.shapes.map((s, i) => normalizeShape(s, i))
    : []
  const project: Project = {
    id: strOr(p.id, uid('p')),
    name: strOr(p.name, '未命名纹样'),
    createdAt,
    updatedAt: numOr(p.updatedAt, createdAt),
    shapes,
    settings,
    export: normalizeExport(p.export),
    sheet: normalizeSheet(p.sheet),
    materialId: strOr(p.materialId, state.materials[0]?.id ?? ''),
    layerNames: Array.isArray(p.layerNames)
      ? (p.layerNames.filter((n) => typeof n === 'string') as string[])
      : [],
    batch: p.batch === undefined ? undefined : normalizeBatch(p.batch),
    batchShapeId: typeof p.batchShapeId === 'string' ? p.batchShapeId : undefined,
  }
  if (project.layerNames.length === 0) project.layerNames = ['图层 1']
  // 批量排版指向的形状不在了就清空，避免打开时错用到别的形状
  if (project.batchShapeId && !shapes.some((s) => s.id === project.batchShapeId)) {
    project.batchShapeId = shapes[0]?.id
  }
  return project
}

function normalizeMaterial(raw: unknown): MaterialPreset | null {
  const m = (raw ?? {}) as Record<string, unknown>
  const id = strOr(m.id, '')
  if (!id) return null
  return {
    id,
    name: strOr(m.name, '未命名材料'),
    paper: strOr(m.paper, 'cardstock'),
    force: numOr(m.force, 100),
    speedMmS: numOr(m.speedMmS, 40),
    passes: Math.max(1, Math.round(numOr(m.passes, 1))),
    bladeOffsetMm: Math.max(0, numOr(m.bladeOffsetMm, 0)),
    backing: strOr(m.backing, ''),
  }
}

// ---------------- 持久化：改动立即写盘 ----------------

export function saveNow(): void {
  if (!canUseStorage() || !state.ready) return
  try {
    const data: Persisted = { version: 1, projects: state.projects, materials: state.materials }
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch (e) {
    state.lastError = `本地保存失败：${(e as Error).message}`
  }
}

/** 立即保存（用户改动入口），失败信息也立即反映到界面 */
function persist(): void {
  saveNow()
}

let saveTimer: number | null = null
export function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 250)
}

/** 页面关闭 / 刷新前把最后的改动写出去 */
function flushBeforeUnload(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveNow()
}

let initialized = false
export function initStore(): void {
  if (initialized) return
  initialized = true
  loadState()
  if (canUseStorage() && typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushBeforeUnload)
    window.addEventListener('beforeunload', flushBeforeUnload)
  }
}

export function loadState(): void {
  state.materials = defaultMaterials()
  if (!canUseStorage()) {
    state.ready = true
    return
  }
  let loaded: unknown = null
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) loaded = JSON.parse(raw)
  } catch (e) {
    state.lastError = `本地数据读取失败：${(e as Error).message}`
  }
  const parsed = (loaded ?? {}) as Persisted
  if (Array.isArray(parsed.materials)) {
    const mats = parsed.materials.map(normalizeMaterial).filter((m): m is MaterialPreset => m !== null)
    if (mats.length > 0) state.materials = mats
  }
  if (Array.isArray(parsed.projects)) {
    state.projects = parsed.projects.map(normalizeProject)
  }
  state.ready = true
  recomputeAll(true)
  // 旧数据补齐字段后回写一次，之后每次刷新读到的都是完整数据
  saveNow()
}

export function materialOf(p: Project): MaterialPreset | null {
  return state.materials.find((m) => m.id === p.materialId) ?? state.materials[0] ?? null
}

/** 重算派生数据（清理结果 → 连刀点 → 刀补 → 包含树 → 切割顺序） */
export function recomputeProject(p: Project, force = false): void {
  const material = materialOf(p)
  for (const shape of p.shapes) {
    const sig = shapeSignature(shape, p.settings, material)
    const cached = computedCache[shape.id]
    if (!force && cached && cached.signature === sig) continue
    const res = computeShape(shape, p.settings, material)
    applyComputed(shape, res)
    computedCache[shape.id] = res
  }
}

export function recomputeAll(force = false): void {
  for (const p of state.projects) recomputeProject(p, force)
}

/** 回写清理/派生警告（连刀点中只有手工放置的保存在数据模型里） */
function applyComputed(shape: Shape, res: ComputedShape): void {
  for (const c of shape.contours) {
    const base = c.warnings.filter(
      (w) => w === 'not_closed' || w === 'self_intersect' || w === 'duplicate' || w === 'too_short',
    ) as ContourWarning[]
    const extra = res.warningUpdates.get(c.id) ?? []
    c.warnings = [...base, ...extra.filter((w) => !base.includes(w))]
  }
}

export function computedOf(shapeId: string): ComputedShape | null {
  return computedCache[shapeId] ?? null
}

/** 排版任务：批量排版开启时只排所选纹样，否则排全部形状 */
export function jobOf(p: Project): { job: Job; shape: Shape | null; isBatch: boolean; computed: Map<string, ComputedShape> } {
  const material = materialOf(p)
  const start = { x: 0, y: 0 }
  const batch = p.batch
  if (batch && batch.enabled) {
    const src = p.shapes.find((s) => s.id === p.batchShapeId) ?? p.shapes[0]
    if (src) {
      const tiled = buildBatchShape(src, batch)
      const sig = `batch|${shapeSignature(src, p.settings, material)}|${batch.rows}|${batch.cols}|${batch.gapXMm}|${batch.gapYMm}|${batch.mode}`
      let comp = batchCache.get(sig)
      if (!comp) {
        comp = computeShape(tiled, p.settings, material, start)
        batchCache.set(sig, comp)
        if (batchCache.size > 24) {
          const firstKey = batchCache.keys().next().value
          if (firstKey !== undefined) batchCache.delete(firstKey)
        }
      }
      const map = new Map<string, ComputedShape>([[tiled.id, comp]])
      const job = buildJob([tiled], map, layerOrderOf(p), { sharedEdge: batch.sharedEdge, start })
      return { job, shape: tiled, isBatch: true, computed: map }
    }
  }
  recomputeProject(p)
  const map = new Map<string, ComputedShape>()
  for (const s of p.shapes) {
    const c = computedCache[s.id]
    if (c) map.set(s.id, c)
  }
  const job = buildJob(p.shapes, map, layerOrderOf(p), { sharedEdge: false, start })
  return { job, shape: null, isBatch: false, computed: map }
}

export function layerOrderOf(p: Project): number[] {
  const set = new Set(p.shapes.map((s) => s.layer))
  return Array.from(set).sort((a, b) => a - b)
}

// ---------------- 项目与形状操作 ----------------

function newProject(name: string, shapes: Shape[]): Project {
  const now = Date.now()
  return {
    id: uid('p'),
    name,
    createdAt: now,
    updatedAt: now,
    shapes,
    settings: { ...DEFAULT_CUT_SETTINGS },
    export: { ...DEFAULT_EXPORT_CFG },
    sheet: { ...DEFAULT_SHEET },
    materialId: state.materials[0]?.id ?? '',
    layerNames: ['图层 1'],
    batch: { ...DEFAULT_BATCH },
  }
}

export function createProjectFromShapes(name: string, shapes: Shape[]): Project {
  const p = newProject(name, shapes)
  state.projects.unshift(p)
  recomputeProject(p, true)
  persist()
  return p
}

export function createBlankProject(name: string): Project {
  return createProjectFromShapes(name, [{ id: uid('s'), name: '新建形状', contours: [], layer: 0 }])
}

export function getProject(id: string): Project | undefined {
  return state.projects.find((p) => p.id === id)
}

export function deleteProject(id: string): void {
  const i = state.projects.findIndex((p) => p.id === id)
  if (i >= 0) {
    const [removed] = state.projects.splice(i, 1)
    for (const s of removed.shapes) delete computedCache[s.id]
    persist()
  }
}

/** 深拷贝一个轮廓（复制项目时重新编号，副本与原件互不影响） */
function cloneContour(c: Contour): Contour {
  return {
    id: uid('c'),
    points: c.points.map((q) => ({ ...q })),
    closed: c.closed,
    area: c.area,
    length: c.length,
    holes: [],
    bridges: c.bridges.map((b) => ({ ...b })),
    warnings: [...c.warnings],
  }
}

function cloneShape(s: Shape, contourIdMap: Map<string, string>): Shape {
  const contours = s.contours.map(cloneContour)
  s.contours.forEach((c, i) => contourIdMap.set(c.id, contours[i].id))
  return {
    id: uid('s'),
    name: s.name,
    contours,
    layer: s.layer,
  }
}

export function duplicateProject(id: string): Project | null {
  const src = getProject(id)
  if (!src) return null
  const now = Date.now()
  const contourIdMap = new Map<string, string>()
  const shapes = src.shapes.map((s) => cloneShape(s, contourIdMap))
  const shapeIdMap = new Map<string, string>()
  src.shapes.forEach((s, i) => shapeIdMap.set(s.id, shapes[i].id))
  const copy: Project = {
    ...src,
    id: uid('p'),
    name: `${src.name} 副本`,
    createdAt: now,
    updatedAt: now,
    shapes,
    settings: { ...src.settings },
    export: { ...src.export },
    sheet: { ...src.sheet },
    layerNames: [...src.layerNames],
    batch: src.batch ? { ...src.batch } : undefined,
    batchShapeId: src.batchShapeId ? shapeIdMap.get(src.batchShapeId) ?? shapes[0]?.id : undefined,
  }
  state.projects.unshift(copy)
  recomputeProject(copy, true)
  persist()
  return copy
}

export function touch(p: Project): void {
  p.updatedAt = Date.now()
  persist()
}

export function addShape(p: Project, shape: Shape): void {
  p.shapes.push(shape)
  recomputeProject(p, true)
  touch(p)
}

export function removeShape(p: Project, shapeId: string): void {
  const i = p.shapes.findIndex((s) => s.id === shapeId)
  if (i >= 0) {
    p.shapes.splice(i, 1)
    delete computedCache[shapeId]
    if (p.batchShapeId === shapeId) p.batchShapeId = p.shapes[0]?.id
    touch(p)
  }
}

export function updateSettings(p: Project, patch: Partial<CutSettings>): void {
  Object.assign(p.settings, patch)
  recomputeProject(p, true)
  touch(p)
}

export function updateExport(p: Project, patch: Partial<ExportCfg>): void {
  Object.assign(p.export, patch)
  touch(p)
}

export function updateSheet(p: Project, sheet: Sheet): void {
  p.sheet = { ...sheet }
  touch(p)
}

export function updateBatch(p: Project, patch: Partial<BatchCfg>): void {
  if (!p.batch) p.batch = { ...DEFAULT_BATCH }
  Object.assign(p.batch, patch)
  touch(p)
}

export function setMaterial(p: Project, materialId: string): void {
  p.materialId = materialId
  recomputeProject(p, true)
  touch(p)
}

/** 一键闭合所有未闭合轮廓 */
export function closeAllOpen(p: Project): number {
  let n = 0
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (!c.closed && c.points.length >= 3) {
        c.closed = true
        c.area = polygonArea(c.points)
        c.length = polylineLength(c.points, true)
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        n += 1
      }
    }
  }
  if (n > 0) {
    recomputeProject(p, true)
    touch(p)
  }
  return n
}

export function closeContour(p: Project, contourId: string): boolean {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id === contourId && !c.closed && c.points.length >= 3) {
        c.closed = true
        c.area = polygonArea(c.points)
        c.length = polylineLength(c.points, true)
        c.warnings = c.warnings.filter((w) => w !== 'not_closed')
        recomputeProject(p, true)
        touch(p)
        return true
      }
    }
  }
  return false
}

export function removeContour(p: Project, contourId: string): void {
  for (const shape of p.shapes) {
    const i = shape.contours.findIndex((c) => c.id === contourId)
    if (i >= 0) {
      shape.contours.splice(i, 1)
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

/** 手工放置连刀点：在指定轮廓上离 p 最近的顶点处 */
export function placeManualBridge(p: Project, contourId: string, atIndex: number): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (c.id !== contourId) continue
      if (!c.bridges.some((b) => b.atIndex === atIndex)) {
        c.bridges.push({ atIndex, widthMm: p.settings.bridgeWidthMm })
      }
      recomputeProject(p, true)
      touch(p)
      return
    }
  }
}

export function clearManualBridges(p: Project, contourId?: string): void {
  for (const shape of p.shapes) {
    for (const c of shape.contours) {
      if (contourId && c.id !== contourId) continue
      c.bridges = []
    }
  }
  recomputeProject(p, true)
  touch(p)
}

/** 纹样对称生成：镜像 / 旋转 / 四方连续 */
export function applySymmetry(p: Project, shapeId: string, op: 'mirror_x' | 'mirror_y' | 'rotate_90' | 'rotate_180' | 'four_way'): void {
  const shape = p.shapes.find((s) => s.id === shapeId)
  if (!shape) return
  const all = shape.contours.flatMap((c) => c.points)
  if (all.length === 0) return
  const minX = Math.min(...all.map((q) => q.x))
  const maxX = Math.max(...all.map((q) => q.x))
  const minY = Math.min(...all.map((q) => q.y))
  const maxY = Math.max(...all.map((q) => q.y))

  const makeCopy = (fn: (x: number, y: number) => { x: number; y: number }): Shape => {
    const contours = shape.contours.map((c) => {
      const pts = c.points.map((q) => {
        const r = fn(q.x, q.y)
        return { x: Math.round(r.x * 1000) / 1000, y: Math.round(r.y * 1000) / 1000 }
      })
      return cloneContour({ ...c, points: pts, holes: [], bridges: [], warnings: [] })
    })
    return { id: uid('s'), name: `${shape.name} 对称`, contours, layer: shape.layer }
  }

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const ops: Array<(x: number, y: number) => { x: number; y: number }> = []
  if (op === 'mirror_x') ops.push((x, y) => ({ x: minX + maxX - x, y }))
  if (op === 'mirror_y') ops.push((x, y) => ({ x, y: minY + maxY - y }))
  if (op === 'rotate_90') ops.push((x, y) => ({ x: cx - (y - cy), y: cy + (x - cx) }))
  if (op === 'rotate_180') ops.push((x, y) => ({ x: 2 * cx - x, y: 2 * cy - y }))
  if (op === 'four_way') {
    ops.push((x, y) => ({ x: minX + maxX - x, y }))
    ops.push((x, y) => ({ x, y: minY + maxY - y }))
    ops.push((x, y) => ({ x: minX + maxX - x, y: minY + maxY - y }))
  }
  for (const fn of ops) p.shapes.push(makeCopy(fn))
  recomputeProject(p, true)
  touch(p)
}

// ---------------- 材料预设 ----------------

export function upsertMaterial(m: MaterialPreset): void {
  const i = state.materials.findIndex((x) => x.id === m.id)
  if (i >= 0) state.materials[i] = { ...m }
  else state.materials.push({ ...m })
  persist()
}

export function deleteMaterial(id: string): void {
  const i = state.materials.findIndex((x) => x.id === id)
  if (i >= 0 && state.materials.length > 1) {
    state.materials.splice(i, 1)
    for (const p of state.projects) {
      if (p.materialId === id) {
        p.materialId = state.materials[0].id
        recomputeProject(p, true)
      }
    }
    persist()
  }
}

// ---------------- 导入 ----------------

export function importSvgToShapes(
  text: string,
  name: string,
  settings: CutSettings,
): { result: ImportResult; shape: Shape } {
  const result = importSvgText(text, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
  const shape: Shape = { id: uid('s'), name, contours: result.contours, layer: 0 }
  return { result, shape }
}

export function addImportedShapes(p: Project, shapes: Shape[]): void {
  for (const s of shapes) p.shapes.push(s)
  recomputeProject(p, true)
  touch(p)
}

export const store = {
  state,
  initStore,
  loadState,
  saveNow,
  scheduleSave,
  materialOf,
  getProject,
  computedOf,
  jobOf,
  layerOrderOf,
  createProjectFromShapes,
  createBlankProject,
  deleteProject,
  duplicateProject,
  addShape,
  addImportedShapes,
  removeShape,
  updateSettings,
  updateExport,
  updateSheet,
  updateBatch,
  setMaterial,
  closeAllOpen,
  closeContour,
  removeContour,
  placeManualBridge,
  clearManualBridges,
  applySymmetry,
  upsertMaterial,
  deleteMaterial,
  recomputeProject,
  recomputeAll,
  importSvgToShapes,
  touch,
}
