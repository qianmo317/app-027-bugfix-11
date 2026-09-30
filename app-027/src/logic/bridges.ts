import type { Bridge, Pt } from './types'
import { dist, pointAtArcLength, polylineLength } from './geometry'

export type CutRun = { points: Pt[]; closed: boolean }

export type BridgeMetrics = {
  /** 实际生效的连刀点数量 */
  count: number
  /** 规则要求的数量 */
  required: number
  /** 每个缺口被挖掉的弧长（mm） */
  arcs: number[]
  /** 缺口两端点之间的直线距离（mm）——物理缺口宽度 */
  widths: number[]
  /** 实际使用的缺口宽度（mm），被削窄时小于设定值 */
  appliedWidthMm: number
  /** 轮廓几何偏差（mm）：被挖弧段相对弦的最大偏离 */
  geometryDeviationMm: number
  /** 挖缺口后重新计算的周长 / 面积 */
  lengthAfter: number
  areaAfter: number
  lengthBefore: number
  areaBefore: number
  /** 因碎片过小被削窄（降级） */
  degraded: boolean
  /** 规则说明 */
  reason: string
}

export type BridgeRuleOptions = {
  rule: 'by_area' | 'by_length' | 'manual'
  areaThresholdMm2: number
  bridgeWidthMm: number
  bridgeEveryMm: number
}

/** 缺口：s 为沿轮廓的精确弧长起点，widthMm 为挖掉的弧长 */
export type BridgeGap = { s: number; widthMm: number; atIndex: number }

/** 连刀点锚点（供预览与放大视图使用） */
export type BridgeAnchor = {
  at: Pt
  end: Pt
  widthMm: number
  atIndex: number
  /** 缺口附近的局部刀路（放大视图用） */
  local: Pt[]
}

export type BridgePlan = {
  gaps: BridgeGap[]
  /** 供数据模型使用（顶点下标 + 宽度） */
  bridges: Bridge[]
  metrics: BridgeMetrics
}

/** 缺口总弧长最多占周长的比例，超过则削窄单个缺口（保证几何不被破坏） */
const MAX_GAP_RATIO = 0.6

/** 累积弧长（到每个顶点的起点） */
export function arcTable(pts: Pt[]): number[] {
  const acc: number[] = new Array(pts.length)
  acc[0] = 0
  for (let i = 1; i < pts.length; i++) acc[i] = acc[i - 1] + dist(pts[i - 1], pts[i])
  return acc
}

/** 找离给定弧长位置最近的顶点下标 */
function nearestIndex(acc: number[], s: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < acc.length; i++) {
    const d = Math.abs(acc[i] - s)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * 连刀点规划（不能只是「随机挖一段」）：
 * 1) 计算面积 A 与周长 L
 * 2) A < areaThreshold → 必须连刀（碎片风险），至少 2 个，分布尽可能均匀
 * 3) 否则按 L / bridgeEveryMm 取整得数量 n（n ≥ 0）
 * 4) 在轮廓上按等弧长取 n 个锚点，每个锚点处沿轮廓挖掉 bridgeWidthMm 的段
 *
 * manualAt 为手工放置的顶点下标（规则为 manual 时使用）。
 */
export function planBridges(
  pts: Pt[],
  closed: boolean,
  area: number,
  length: number,
  opts: BridgeRuleOptions,
  manualAt: number[] = [],
): BridgePlan {
  const L = length || polylineLength(pts, closed)
  const A = area
  const required =
    opts.rule === 'manual'
      ? manualAt.length
      : !closed || pts.length < 3 || L <= 0
        ? 0
        : A < opts.areaThresholdMm2
          ? 2
          : Math.floor(L / Math.max(opts.bridgeEveryMm, 0.001))

  const metrics: BridgeMetrics = {
    count: 0,
    required,
    arcs: [],
    widths: [],
    appliedWidthMm: opts.bridgeWidthMm,
    geometryDeviationMm: 0,
    lengthBefore: L,
    areaBefore: A,
    lengthAfter: L,
    areaAfter: A,
    degraded: false,
    reason: '',
  }

  if (required <= 0) {
    metrics.reason =
      opts.rule === 'manual'
        ? '手工放置：未添加连刀点'
        : closed
          ? `周长 ${L.toFixed(2)}mm < 每段 ${opts.bridgeEveryMm}mm，无需连刀`
          : '未闭合轮廓无法连刀'
    return { gaps: [], bridges: [], metrics }
  }

  // 单个缺口宽度上限：保证 n 个缺口总弧长 ≤ 60% 周长，且相邻缺口不重叠
  const appliedWidth = Math.min(opts.bridgeWidthMm, (MAX_GAP_RATIO * L) / required)
  metrics.appliedWidthMm = appliedWidth
  if (appliedWidth < opts.bridgeWidthMm - 1e-9) {
    metrics.degraded = true
    metrics.reason = `轮廓总长 ${L.toFixed(2)}mm 过短，缺口宽度由 ${opts.bridgeWidthMm}mm 削窄至 ${appliedWidth.toFixed(3)}mm（保留 ${required} 个连刀点）`
  }

  const acc = arcTable(pts)
  const rawS: number[] = []
  const rawIdx: number[] = []
  if (opts.rule === 'manual') {
    for (const m of manualAt) {
      const idx = Math.max(0, Math.min(pts.length - 1, Math.round(m)))
      rawS.push(acc[idx])
      rawIdx.push(idx)
    }
    metrics.reason = `手工放置 ${rawS.length} 个连刀点`
  } else if (A < opts.areaThresholdMm2) {
    // 碎片：两个连刀点尽量均匀（相隔半个周长）
    rawS.push(L * 0.25, L * 0.75)
    rawIdx.push(nearestIndex(acc, L * 0.25), nearestIndex(acc, L * 0.75))
    metrics.reason = `碎片面积 ${A.toFixed(2)}mm² < 阈值 ${opts.areaThresholdMm2}mm²，强制 ${rawS.length} 个连刀点（均匀分布）`
  } else {
    for (let k = 0; k < required; k++) {
      const s = (L * (k + 0.5)) / required
      rawS.push(s)
      rawIdx.push(nearestIndex(acc, s))
    }
    metrics.reason = `周长 ${L.toFixed(2)}mm ÷ ${opts.bridgeEveryMm}mm → ${required} 个连刀点（等弧长分布）`
  }

  const gaps: BridgeGap[] = rawS.map((s, i) => ({
    s: ((s % L) + L) % L,
    widthMm: Math.round(appliedWidth * 10000) / 10000,
    atIndex: rawIdx[i],
  }))
  gaps.sort((a, b) => a.s - b.s)
  // 手工放置尊重用户点选位置，不做吸附；规则生成则吸附到单条直线段内
  const snapped = opts.rule === 'manual' ? { gaps, dropped: 0 } : snapGapsToEdges(pts, acc, L, gaps)
  if (snapped.dropped > 0) {
    metrics.degraded = true
    metrics.reason += `；${snapped.dropped} 个连刀点因相邻间距不足被合并`
  }
  for (const g of snapped.gaps) g.atIndex = nearestIndex(acc, g.s)

  const stats = gapStats(pts, L, snapped.gaps)
  metrics.count = snapped.gaps.length
  metrics.arcs = snapped.gaps.map((g) => g.widthMm)
  metrics.widths = stats.widths
  metrics.geometryDeviationMm = stats.deviation
  metrics.lengthAfter = L - snapped.gaps.reduce((a, g) => a + g.widthMm, 0)
  metrics.areaAfter = Math.max(0, A - stats.removedArea)

  return {
    gaps: snapped.gaps,
    bridges: snapped.gaps.map((g) => ({ atIndex: g.atIndex, widthMm: g.widthMm })),
    metrics,
  }
}

/**
 * 把缺口吸附到「单条直线段」内部：缺口不跨越折角。
 * 这样缺口两端是平滑过渡（避免刀路折角），且缺口宽度 = 弦长 = 设定值，几何偏差为 0。
 */
function snapGapsToEdges(pts: Pt[], acc: number[], L: number, gaps: BridgeGap[]): { gaps: BridgeGap[]; dropped: number } {
  const n = pts.length
  const edges: Array<{ i: number; lo: number; hi: number }> = []
  for (let i = 0; i < n; i++) {
    const lo = acc[i]
    const hi = i + 1 < n ? acc[i + 1] : L
    if (hi - lo > 1e-9) edges.push({ i, lo, hi })
  }
  if (edges.length === 0) return { gaps, dropped: 0 }

  const out: BridgeGap[] = []
  for (const g of gaps) {
    const w = g.widthMm
    const fitting = edges.filter((e) => e.hi - e.lo >= w + 1e-9)
    let edge: { i: number; lo: number; hi: number } | null = null
    const containing = edges.find((e) => g.s >= e.lo - 1e-9 && g.s < e.hi - 1e-9)
    if (containing && containing.hi - containing.lo >= w + 1e-9) {
      edge = containing
    } else if (fitting.length > 0) {
      // 所在边太短 → 取弧长距离最近的可容纳边
      let best = fitting[0]
      let bestD = Infinity
      for (const e of fitting) {
        const d = g.s < e.lo ? e.lo - g.s : g.s > e.hi ? g.s - e.hi : 0
        if (d < bestD) {
          bestD = d
          best = e
        }
      }
      edge = best
    }
    if (!edge) {
      // 没有任何边能容纳：取最长边并把宽度削到该边的 60%
      let longest = edges[0]
      for (const e of edges) if (e.hi - e.lo > longest.hi - longest.lo) longest = e
      const len = longest.hi - longest.lo
      const w2 = Math.max(0.02, Math.min(w, len * 0.6))
      const s2 = longest.lo + (len - w2) / 2
      out.push({ s: s2, widthMm: Math.round(w2 * 10000) / 10000, atIndex: g.atIndex })
      continue
    }
    const lo = edge.lo
    const hi = edge.hi - w
    let s = g.s
    if (s < lo || s > hi) s = lo + (hi - lo) / 2
    else s = Math.min(Math.max(s, lo), hi)
    out.push({ s, widthMm: g.widthMm, atIndex: g.atIndex })
  }

  out.sort((a, b) => a.s - b.s)
  // 相邻缺口不得重叠
  const kept: BridgeGap[] = []
  let dropped = 0
  for (const g of out) {
    const prev = kept[kept.length - 1]
    if (prev && g.s < prev.s + prev.widthMm + 1e-6) {
      dropped += 1
      continue
    }
    // 末位与首位（跨起点）也不得重叠
    if (g === out[out.length - 1] && kept.length > 0) {
      const first = kept[0]
      if (first.s + L < g.s + g.widthMm + 1e-6) {
        dropped += 1
        continue
      }
    }
    kept.push(g)
  }
  return { gaps: kept, dropped }
}

function gapStats(
  pts: Pt[],
  L: number,
  gaps: BridgeGap[],
): { widths: number[]; deviation: number; removedArea: number } {
  const widths: number[] = []
  let deviation = 0
  let removedArea = 0
  for (const g of gaps) {
    const a = pointAtArcLength(pts, true, g.s)
    const b = pointAtArcLength(pts, true, (g.s + g.widthMm) % L)
    widths.push(dist(a, b))
    const samples: Pt[] = []
    const steps = 10
    for (let i = 0; i <= steps; i++) samples.push(pointAtArcLength(pts, true, (g.s + (g.widthMm * i) / steps) % L))
    for (const p of samples) deviation = Math.max(deviation, pointToSegment(p, a, b))
    // 缺口面积 = 被挖弧段与弦围成的闭合多边形（必须回到起点，否则鞋带公式会算出到原点的三角形）
    let polyArea = 0
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i]
      const q = samples[(i + 1) % samples.length]
      polyArea += p.x * q.y - q.x * p.y
    }
    removedArea += Math.abs(polyArea / 2)
  }
  return { widths, deviation, removedArea }
}

function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 < 1e-12) return dist(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/**
 * 应用连刀点：把闭合轮廓拆成若干「切割段」。
 * 闭合轮廓有 n 个缺口就有 n 段刀路（缺口处刀抬起跳过，跨过起点首尾段会正确合并）。
 */
export function applyBridges(pts: Pt[], closed: boolean, gaps: BridgeGap[]): CutRun[] {
  if (!closed || gaps.length === 0) return [{ points: pts, closed }]
  const n = pts.length
  if (n < 3) return [{ points: pts, closed }]
  const L = polylineLength(pts, true)
  if (L <= 0) return [{ points: pts, closed }]
  const acc = arcTable(pts)
  const sorted = gaps.slice().sort((a, b) => a.s - b.s)

  const runs: CutRun[] = []
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i].s + sorted[i].widthMm
    const b = (i + 1 < sorted.length ? sorted[i + 1].s : sorted[0].s) + (i + 1 < sorted.length ? 0 : L)
    const points = collectRun(pts, acc, L, a, b)
    if (points.length >= 2) runs.push({ points, closed: false })
  }
  return runs.length > 0 ? runs : [{ points: pts, closed: true }]
}

/** 取自弧长 a 到 b 的折线（b 可超过 L，表示跨越起点） */
function collectRun(pts: Pt[], acc: number[], L: number, a: number, b: number): Pt[] {
  const out: Pt[] = [{ ...pointAtArcLength(pts, true, a % L) }]
  const push = (p: Pt) => {
    const last = out[out.length - 1]
    if (!last || dist(last, p) > 1e-6) out.push(p)
  }
  const inRange = (s: number) => s > a + 1e-9 && s < b - 1e-9
  for (let i = 0; i < pts.length; i++) {
    const s = acc[i]
    if (inRange(s)) push(pts[i])
    if (inRange(s + L)) push(pts[i])
  }
  push({ ...pointAtArcLength(pts, true, b % L) })
  return out
}

/** 由刀路段推导连刀点锚点（缺口 = 上一段末尾 → 下一段开头） */
export function anchorsFromRuns(runs: CutRun[], widthMm: number, atIndices: number[] = [], gapCount = 0): BridgeAnchor[] {
  if (runs.length === 0) return []
  // 只有 1 个缺口时：整条轮廓成为 1 段开口刀路，缺口在首尾之间
  if (runs.length === 1) {
    if (gapCount <= 0) return []
    const p = runs[0].points
    if (p.length < 2) return []
    return [
      {
        at: p[p.length - 1],
        end: p[0],
        widthMm,
        atIndex: atIndices[0] ?? 0,
        local: [...p.slice(-4), ...p.slice(0, 4)],
      },
    ]
  }
  const out: BridgeAnchor[] = []
  for (let i = 0; i < runs.length; i++) {
    const cur = runs[i]
    const next = runs[(i + 1) % runs.length]
    const at = cur.points[cur.points.length - 1]
    const end = next.points[0]
    const local = [...cur.points.slice(-4), ...next.points.slice(0, 4)]
    out.push({ at, end, widthMm, atIndex: atIndices[i] ?? 0, local })
  }
  return out
}