import type { Bridge, ContourWarning, CutSettings, MaterialPreset, Pt, Shape } from './types'
import { anchorsFromRuns, applyBridges, planBridges, type BridgeAnchor, type BridgeMetrics, type CutRun } from './bridges'
import { buildContainmentTree, type NestingResult } from './nesting'
import { orderCut, type OrderResult } from './order'
import { offsetPolygon } from './offset'
import { boundsOf, mergeBounds, polygonArea, polylineLength, type Bounds } from './geometry'

export type ComputedContour = {
  id: string
  /** 最终刀路（已做刀补 + 连刀点开挖） */
  runs: CutRun[]
  bridgeMetrics: BridgeMetrics
  /** 连刀点锚点（预览 / 放大视图） */
  anchors: BridgeAnchor[]
  offsetOk: boolean
  offsetMessage: string
}

export type ComputedShape = {
  shapeId: string
  tree: NestingResult
  order: OrderResult
  byId: Map<string, ComputedContour>
  stats: {
    contourCount: number
    closedCount: number
    openCount: number
    cutLengthMm: number
    travelMm: number
    naiveTravelMm: number
    improvementPct: number
    approachMm: number
    bridgeCount: number
    fragmentCount: number
    cappedBridgeCount: number
    maxDepth: number
    netAreaMm2: number
    bbox: Bounds
    geometryDeviationMm: number
    offsetFailed: number
  }
  /** 需要写回轮廓的警告 */
  warningUpdates: Map<string, ContourWarning[]>
  elapsedMs: number
  signature: string
}

/** 几何签名：用于缓存失效判断（点坐标和 / 点数 / 参数） */
export function shapeSignature(shape: Shape, settings: CutSettings, material: MaterialPreset | null): string {
  let h = 0
  let n = 0
  for (const c of shape.contours) {
    for (const p of c.points) {
      h = (h + p.x * 7.13 + p.y * 3.71) % 1e9
      n += 1
    }
    // 手工连刀点也参与签名
    for (const b of c.bridges) h = (h + b.atIndex * 1.7 + b.widthMm * 11.3) % 1e9
  }
  return [
    shape.id,
    shape.layer,
    shape.contours.length,
    n,
    Math.round(h * 1000),
    settings.bridgeRule,
    settings.areaThresholdMm2,
    settings.bridgeWidthMm,
    settings.bridgeEveryMm,
    settings.travelOptimize,
    settings.useBladeOffset,
    material ? material.bladeOffsetMm : 0,
  ].join('|')
}

/** 把「按弧长比例」的缺口映射到（可能被刀补裁剪成多段的）刀路上 */
function mapGapsToLoops(
  loops: Pt[][],
  gaps: Array<{ frac: number; widthMm: number; atIndex: number }>,
): CutRun[] {
  if (gaps.length === 0) return loops.map((p) => ({ points: p, closed: true }))
  const lens = loops.map((l) => polylineLength(l, true))
  const total = lens.reduce((a, b) => a + b, 0)
  if (total <= 0) return loops.map((p) => ({ points: p, closed: true }))
  const accStart: number[] = []
  let running = 0
  for (const l of lens) {
    accStart.push(running)
    running += l
  }
  const byLoop: Array<Array<{ s: number; widthMm: number; atIndex: number }>> = loops.map(() => [])
  for (const g of gaps) {
    const s = ((g.frac % 1) + 1) % 1 * total
    let li = loops.length - 1
    for (let i = 0; i < loops.length; i++) {
      if (s >= accStart[i] && (i === loops.length - 1 || s < accStart[i] + lens[i])) {
        li = i
        break
      }
    }
    const sLocal = Math.min(Math.max(0, s - accStart[li]), Math.max(0, lens[li] - 1e-6))
    byLoop[li].push({ s: sLocal, widthMm: g.widthMm, atIndex: g.atIndex })
  }
  const runs: CutRun[] = []
  loops.forEach((pts, i) => {
    const gaps = byLoop[i].map((g) => ({ s: g.s, widthMm: g.widthMm, atIndex: g.atIndex }))
    runs.push(...applyBridges(pts, true, gaps))
  })
  return runs
}

/**
 * 单形状全流程：刀补 → 连刀点 → 包含树 → 切割顺序（先内后外 + 跳刀优化）。
 * 纯函数，不修改传入的 shape。
 */
export function computeShape(
  shape: Shape,
  settings: CutSettings,
  material: MaterialPreset | null,
  start: Pt = { x: 0, y: 0 },
): ComputedShape {
  const t0 = performance.now()
  const tree = buildContainmentTree(shape.contours)

  const byId = new Map<string, ComputedContour>()
  const runsOf = new Map<string, CutRun[]>()
  const warningUpdates = new Map<string, ContourWarning[]>()

  let bridgeCount = 0
  let fragmentCount = 0
  let cappedBridgeCount = 0
  let geometryDeviationMm = 0
  let offsetFailed = 0

  for (const c of shape.contours) {
    const warnings: ContourWarning[] = []
    const depth = tree.depthOf.get(c.id) ?? 1
    const bladeOffset = settings.useBladeOffset && material ? material.bladeOffsetMm : 0
    const offsetDir = depth % 2 === 1 ? 1 : -1 // 外层向外、内层（孔）向内
    const isFragment = c.closed && c.area < settings.areaThresholdMm2
    if (isFragment) fragmentCount += 1

    // 1) 连刀点规划（原始轮廓上按等弧长取锚点）
    const plan = planBridges(
      c.points,
      c.closed,
      c.area,
      c.length,
      {
        rule: settings.bridgeRule,
        areaThresholdMm2: settings.areaThresholdMm2,
        bridgeWidthMm: settings.bridgeWidthMm,
        bridgeEveryMm: settings.bridgeEveryMm,
      },
      c.bridges.map((b) => b.atIndex),
    )
    bridgeCount += plan.metrics.count
    if (plan.metrics.degraded) {
      cappedBridgeCount += 1
      warnings.push('bridge_degraded')
    }
    geometryDeviationMm = Math.max(geometryDeviationMm, plan.metrics.geometryDeviationMm)
    const L = plan.metrics.lengthBefore || polylineLength(c.points, c.closed)
    const gapFracs = plan.gaps.map((g) => ({
      frac: L > 0 ? g.s / L : 0,
      widthMm: g.widthMm,
      atIndex: g.atIndex,
    }))

    // 2) 刀补（会产生凹角自交，需裁剪；失败则明确警告并保留原路径）
    let loops: Pt[][] = [c.points]
    let offsetOk = true
    let offsetMessage = ''
    if (bladeOffset > 1e-6 && c.closed) {
      const res = offsetPolygon(c.points, bladeOffset * offsetDir)
      offsetOk = res.ok
      offsetMessage = res.message
      if (!res.ok) {
        offsetFailed += 1
        warnings.push('offset_failed')
      } else {
        loops = res.runs.map((r) => r.points)
        if (res.clipped) warnings.push('offset_clipped')
      }
    }

    // 3) 连刀点开挖 → 切割段
    const runs = c.closed ? mapGapsToLoops(loops, gapFracs) : [{ points: c.points, closed: false }]
    const anchors = c.closed
      ? anchorsFromRuns(
          runs,
          plan.metrics.appliedWidthMm,
          plan.gaps.map((g) => g.atIndex),
          plan.gaps.length,
        )
      : []

    byId.set(c.id, { id: c.id, runs, bridgeMetrics: plan.metrics, anchors, offsetOk, offsetMessage })
    runsOf.set(c.id, runs)
    if (warnings.length > 0) warningUpdates.set(c.id, warnings)
  }

  // 4) 切割顺序：先内后外 + 同层最近邻/2-opt
  const order = orderCut(runsOf, tree, {
    optimize: settings.travelOptimize,
    start,
    layerOf: () => shape.layer,
  })

  let cutLengthMm = 0
  for (const st of order.steps) cutLengthMm += st.lengthMm

  // 净面积：偶层为正、奇层（孔）为负
  let netAreaMm2 = 0
  for (const c of shape.contours) {
    if (!c.closed) continue
    const depth = tree.depthOf.get(c.id) ?? 1
    netAreaMm2 += (depth % 2 === 1 ? 1 : -1) * polygonArea(c.points)
  }

  const bbox =
    shape.contours.length > 0
      ? mergeBounds(shape.contours.map((c) => boundsOf(c.points)))
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  return {
    shapeId: shape.id,
    tree,
    order,
    byId,
    stats: {
      contourCount: shape.contours.length,
      closedCount: shape.contours.filter((c) => c.closed).length,
      openCount: shape.contours.filter((c) => !c.closed).length,
      cutLengthMm,
      travelMm: order.travelMm,
      naiveTravelMm: order.naiveTravelMm,
      improvementPct: order.improvementPct,
      approachMm: order.approachMm,
      bridgeCount,
      fragmentCount,
      cappedBridgeCount,
      maxDepth: tree.maxDepth,
      netAreaMm2,
      bbox,
      geometryDeviationMm,
      offsetFailed,
    },
    warningUpdates,
    elapsedMs: performance.now() - t0,
    signature: shapeSignature(shape, settings, material),
  }
}

export type { Bridge }