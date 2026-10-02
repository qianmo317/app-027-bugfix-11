import { reactive, watch } from 'vue'
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
  type Pt,
  type Shape,
  type Sheet,
} from './types'
import { computeShape, shapeSignature, type ComputedShape } from './pipeline'
import { buildBatchShape, buildJob, type Job } from './job'
import { polygonArea, polylineLength, uid } from './geometry'
import { importSvgText, type ImportResult } from './importer'
import { defaultMaterials } from '@/data/materials'

const LS_KEY = 'papercut-plotter-studio/v1'

type Persisted = {
  version: number
  projects: Project[]
  materials: MaterialPreset[]
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

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function loadState(): void {
  // 只在启动时加载一次：重复调用不能覆盖内存里尚未落盘的新改动
  if (state.ready) return
  const fallback = defaultMaterials()
  if (!canUseStorage()) {
    state.materials = fallback
    state.ready = true
    return
  }
  let loadedOk = false
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>
      const materials = Array.isArray(parsed?.materials)
        ? parsed.materials.map(normalizeMaterial).filter((m): m is MaterialPreset => m !== null)
        : []
      state.materials = materials.length > 0 ? materials : fallback
      // 全部项目都要读回来（不能只读第一个），逐个补齐缺失字段
      state.projects = Array.isArray(parsed?.projects)
        ? parsed.projects.map(normalizeProject).filter((p): p is Project => p !== null)
        : []
      loadedOk = true
    } else {
      state.materials = fallback
    }
  } catch (e) {
    state.materials = fallback
    state.projects = []
    state.lastError = `本地数据读取失败：${(e as Error).message}`
  }
  state.ready = true
  recomputeAll()
  // 补齐字段后的数据立刻写回本机（解析失败的原始数据不覆盖，保留现场）
  if (loadedOk) scheduleSave()
}

export function saveNow(): void {
  if (!state.ready) return
  if (!canUseStorage()) return
  try {
    const data: Persisted = { version: 1, projects: state.projects, materials: state.materials }
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch (e) {
    state.lastError = `本地保存失败：${(e as Error).message}`
  }
}

let saveTimer: number | null = null
export function scheduleSave(): void {
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 250)
}

// 刷新 / 关闭页面前把还在防抖队列里的改动立刻落盘
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => saveNow())
}

// ---------------- 读取旧数据：补齐缺失字段 ----------------

const CONTOUR_WARNINGS: ContourWarning[] = [
  'not_closed',
  'self_intersect',
  'duplicate',
  'offset_clipped',
  'offset_failed',
  'bridge_degraded',
  'too_short',
]

function defaultBatch(): BatchCfg {
  return { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function oneOf<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

/** 用默认值补齐缺失字段（旧版本数据可能缺后加的键），非法值（null/undefined）不覆盖默认值 */
function mergeDefaults<T extends object>(defaults: T, raw: unknown): T {
  const out = { ...defaults } as Record<string, unknown>
  if (isRecord(raw)) {
    for (const k of Object.keys(defaults)) {
      const v = raw[k]
      if (v !== undefined && v !== null) out[k] = v
    }
  }
  return out as T
}

function normalizeContour(raw: unknown): Contour | null {
  if (!isRecord(raw)) return null
  const points: Pt[] = []
  if (Array.isArray(raw.points)) {
    for (const p of raw.points) {
      if (isRecord(p) && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        points.push({ x: p.x, y: p.y })
      }
    }
  }
  const closed = raw.closed === true
  const bridges: Bridge[] = []
  if (Array.isArray(raw.bridges)) {
    for (const b of raw.bridges) {
      if (isRecord(b) && typeof b.atIndex === 'number' && Number.isFinite(b.atIndex)) {
        bridges.push({ atIndex: b.atIndex, widthMm: num(b.widthMm, DEFAULT_CUT_SETTINGS.bridgeWidthMm) })
      }
    }
  }
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is ContourWarning => CONTOUR_WARNINGS.includes(w as ContourWarning))
    : []
  const holes = Array.isArray(raw.holes) ? raw.holes.filter((h): h is string => typeof h === 'string') : []
  return {
    id: str(raw.id, uid('c')),
    points,
    closed,
    // 派分值缺失时按点列重算，否则连刀点规则会拿到空值
    area: num(raw.area, closed ? polygonArea(points) : 0),
    length: num(raw.length, polylineLength(points, closed)),
    holes,
    bridges,
    warnings,
  }
}

function normalizeShape(raw: unknown): Shape | null {
  if (!isRecord(raw)) return null
  const contours = Array.isArray(raw.contours)
    ? raw.contours.map(normalizeContour).filter((c): c is Contour => c !== null)
    : []
  return {
    id: str(raw.id, uid('s')),
    name: str(raw.name, '未命名形状'),
    contours,
    layer: Math.max(0, Math.round(num(raw.layer, 0))),
  }
}

function normalizeProject(raw: unknown): Project | null {
  if (!isRecord(raw)) return null
  const now = Date.now()
  const shapes = Array.isArray(raw.shapes)
    ? raw.shapes.map(normalizeShape).filter((s): s is Shape => s !== null)
    : []
  const layerNames = Array.isArray(raw.layerNames)
    ? raw.layerNames.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : []
  const settings = mergeDefaults(DEFAULT_CUT_SETTINGS, raw.settings)
  settings.order = 'inner_first'
  settings.bridgeRule = oneOf(settings.bridgeRule, ['by_area', 'by_length', 'manual'] as const, DEFAULT_CUT_SETTINGS.bridgeRule)
  settings.travelOptimize = oneOf(settings.travelOptimize, ['nearest', 'nearest_2opt'] as const, DEFAULT_CUT_SETTINGS.travelOptimize)
  const exportCfg = mergeDefaults(DEFAULT_EXPORT_CFG, raw.export)
  exportCfg.format = oneOf(exportCfg.format, ['plt', 'gcode', 'svg'] as const, DEFAULT_EXPORT_CFG.format)
  exportCfg.unit = oneOf(exportCfg.unit, ['mm', '0.025mm'] as const, DEFAULT_EXPORT_CFG.unit)
  exportCfg.origin = oneOf(exportCfg.origin, ['bottom_left', 'top_left'] as const, DEFAULT_EXPORT_CFG.origin)
  const batch = mergeDefaults(defaultBatch(), raw.batch)
  batch.mode = oneOf(batch.mode, ['repeat', 'four_way'] as const, 'repeat')
  const materialId = str(raw.materialId, '')
  const batchShapeId = str(raw.batchShapeId, '')
  return {
    id: str(raw.id, uid('p')),
    name: str(raw.name, '未命名项目'),
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
    shapes,
    settings,
    export: exportCfg,
    sheet: mergeDefaults(DEFAULT_SHEET, raw.sheet),
    materialId: state.materials.some((m) => m.id === materialId) ? materialId : (state.materials[0]?.id ?? ''),
    layerNames: layerNames.length > 0 ? layerNames : ['图层 1'],
    batch,
    batchShapeId: shapes.some((s) => s.id === batchShapeId) ? batchShapeId : undefined,
  }
}

function normalizeMaterial(raw: unknown): MaterialPreset | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return null
  return {
    id: raw.id,
    name: str(raw.name, '未命名材料'),
    paper: str(raw.paper, 'cardstock'),
    force: num(raw.force, 100),
    speedMmS: num(raw.speedMmS, 40),
    passes: Math.max(1, Math.round(num(raw.passes, 1))),
    bladeOffsetMm: num(raw.bladeOffsetMm, 0.25),
    backing: str(raw.backing, ''),
  }
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
    batch: defaultBatch(),
  }
}

export function createProjectFromShapes(name: string, shapes: Shape[]): Project {
  const p = newProject(name, shapes)
  state.projects.unshift(p)
  recomputeProject(p, true)
  scheduleSave()
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
    state.projects.splice(i, 1)
    scheduleSave()
  }
}

/**
 * 复制项目：深拷贝所有形状 / 轮廓并全部换新 id（holes、batchShapeId 同步重映射），
 * 副本与原件互不影响，派生缓存也各算各的。
 */
export function duplicateProject(id: string): Project | null {
  const src = getProject(id)
  if (!src) return null
  const now = Date.now()
  const shapeIds = new Map<string, string>()
  const shapes: Shape[] = src.shapes.map((s) => {
    const newShapeId = uid('s')
    shapeIds.set(s.id, newShapeId)
    const contourIds = new Map<string, string>()
    const contours: Contour[] = s.contours.map((c) => {
      const newContourId = uid('c')
      contourIds.set(c.id, newContourId)
      return {
        id: newContourId,
        points: c.points.map((p) => ({ ...p })),
        closed: c.closed,
        area: c.area,
        length: c.length,
        holes: [...c.holes],
        bridges: c.bridges.map((b) => ({ ...b })),
        warnings: [...c.warnings],
      }
    })
    // holes 里存的是原件轮廓 id，重映射到副本的新 id
    for (const nc of contours) {
      nc.holes = nc.holes.map((h) => contourIds.get(h)).filter((h): h is string => h !== undefined)
    }
    return { id: newShapeId, name: s.name, contours, layer: s.layer }
  })
  const batchShapeId = src.batchShapeId ? shapeIds.get(src.batchShapeId) : undefined
  const copy: Project = {
    id: uid('p'),
    name: `${src.name} 副本`,
    createdAt: now,
    updatedAt: now,
    shapes,
    settings: { ...src.settings },
    export: { ...src.export },
    sheet: { ...src.sheet },
    materialId: src.materialId,
    layerNames: [...src.layerNames],
    batch: src.batch ? { ...src.batch } : undefined,
    batchShapeId,
  }
  state.projects.unshift(copy)
  recomputeProject(copy, true)
  scheduleSave()
  return copy
}

export function touch(p: Project): void {
  p.updatedAt = Date.now()
  scheduleSave()
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
  if (!p.batch) p.batch = defaultBatch()
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
      return { ...c, id: uid('c'), points: pts, holes: [], bridges: [], warnings: [] }
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
  scheduleSave()
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
    scheduleSave()
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

watch(
  () => [state.projects, state.materials],
  () => {
    if (state.ready) scheduleSave()
  },
  { deep: true },
)

export const store = {
  state,
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