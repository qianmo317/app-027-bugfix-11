import type { BatchCfg, Contour, Pt, Shape } from './types'
import type { ComputedShape } from './pipeline'
import { dedupeSharedEdges } from './exporters'
import { makeContour } from './cleanup'
import { boundsOf, dist, uid } from './geometry'
import type { CutStep } from './order'

export type JobStep = CutStep & { shapeId: string; shapeName: string; shapeLayer: number }

export type Job = {
  steps: JobStep[]
  travelMm: number
  naiveTravelMm: number
  improvementPct: number
  cutLengthMm: number
  runCount: number
  perShape: Record<string, number>
  shapeOrder: string[]
}

/** 批量排版：同一纹样在纸上排满（间距可调，间距为 0 时可共边裁切） */
export function buildBatchShape(shape: Shape, batch: BatchCfg): Shape {
  const rows = Math.max(1, Math.round(batch.rows))
  const cols = Math.max(1, Math.round(batch.cols))
  if (!batch.enabled || (rows === 1 && cols === 1)) return shape
  const all = shape.contours.flatMap((c) => c.points)
  const b = boundsOf(all)
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  const stepX = w + Math.max(0, batch.gapXMm)
  const stepY = h + Math.max(0, batch.gapYMm)

  const contours: Contour[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const mirrorX = batch.mode === 'four_way' && c % 2 === 1
      const mirrorY = batch.mode === 'four_way' && r % 2 === 1
      const ox = b.minX + c * stepX
      const oy = b.minY + r * stepY
      for (const src of shape.contours) {
        const pts = src.points.map((p) => {
          const x = mirrorX ? b.maxX - (p.x - b.minX) : p.x
          const y = mirrorY ? b.maxY - (p.y - b.minY) : p.y
          return { x: x - b.minX + ox, y: y - b.minY + oy }
        })
        const nc = makeContour(pts, src.closed, src.warnings.filter((wn) => wn === 'not_closed' || wn === 'self_intersect'))
        contours.push(nc)
      }
    }
  }
  return { ...shape, id: uid('batch'), name: `${shape.name}（${cols}×${rows} 排版）`, contours }
}

function shapeStart(s: ComputedShape): Pt {
  const st = s.order.steps[0]
  return st ? st.startPt : { x: 0, y: 0 }
}

function shapeEnd(s: ComputedShape): Pt {
  const st = s.order.steps[s.order.steps.length - 1]
  return st ? st.endPt : { x: 0, y: 0 }
}

/**
 * 组合多形状 / 多图层的切割任务：图层顺序 → 同层形状最近邻 → 各形状内部先内后外。
 */
export function buildJob(
  shapes: Shape[],
  computedById: Map<string, ComputedShape>,
  layerOrder: number[],
  opts: { sharedEdge: boolean; start: Pt },
): Job {
  const list = shapes.map((s) => ({ shape: s, comp: computedById.get(s.id) })).filter((x) => x.comp) as Array<{
    shape: Shape
    comp: ComputedShape
  }>

  const layers = Array.from(new Set(list.map((x) => x.shape.layer)))
  const orderedLayers = layers.slice().sort((a, b) => {
    const ia = layerOrder.indexOf(a)
    const ib = layerOrder.indexOf(b)
    if (ia === -1 && ib === -1) return a - b
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })

  const shapeOrder: string[] = []
  const naiveShapeOrder: string[] = []
  for (const layer of orderedLayers) {
    const inLayer = list.filter((x) => x.shape.layer === layer)
    const remaining = inLayer.slice()
    let cursor: Pt = opts.start
    if (shapeOrder.length > 0) {
      const prev = list.find((x) => x.shape.id === shapeOrder[shapeOrder.length - 1])
      if (prev) cursor = shapeEnd(prev.comp)
    }
    while (remaining.length > 0) {
      let best = 0
      let bestD = Infinity
      remaining.forEach((x, i) => {
        const d = dist(cursor, shapeStart(x.comp))
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      const picked = remaining.splice(best, 1)[0]
      shapeOrder.push(picked.shape.id)
      cursor = shapeEnd(picked.comp)
    }
    for (const x of inLayer) naiveShapeOrder.push(x.shape.id)
  }

  const build = (order: string[], withTravel: boolean): JobStep[] => {
    const out: JobStep[] = []
    let cursor: Pt = opts.start
    let seq = 0
    let first = true
    for (const id of order) {
      const item = list.find((x) => x.shape.id === id)
      if (!item) continue
      const steps = item.comp.order.steps
      if (steps.length === 0) continue
      // 形状内第一段的跳刀 = 从上一形状末尾跳过来
      let prevTravel = withTravel && !first ? dist(cursor, steps[0].startPt) : 0
      for (const st of steps) {
        seq += 1
        out.push({
          ...st,
          seq,
          shapeId: item.shape.id,
          shapeName: item.shape.name,
          shapeLayer: item.shape.layer,
          travelFromPrevMm: st === steps[0] ? prevTravel : st.travelFromPrevMm,
        })
      }
      cursor = steps[steps.length - 1].endPt
      prevTravel = 0
      first = false
    }
    return out
  }

  let steps = build(shapeOrder, true)
  const naiveSteps = build(naiveShapeOrder, true)

  if (opts.sharedEdge) {
    steps = dedupeSharedEdges(steps)
    steps = steps.map((s, i) => ({ ...s, seq: i + 1 }))
  }

  const travelMm = steps.reduce((a, s) => a + s.travelFromPrevMm, 0)
  const naiveTravelMm = naiveSteps.reduce((a, s) => a + s.travelFromPrevMm, 0)
  const cutLengthMm = steps.reduce((a, s) => a + s.lengthMm, 0)
  const perShape: Record<string, number> = {}
  for (const s of steps) perShape[s.shapeId] = (perShape[s.shapeId] ?? 0) + 1

  return {
    steps,
    travelMm,
    naiveTravelMm,
    improvementPct: naiveTravelMm > 1e-9 ? ((naiveTravelMm - travelMm) / naiveTravelMm) * 100 : 0,
    cutLengthMm,
    runCount: steps.length,
    perShape,
    shapeOrder,
  }
}

/** 仿真关键点（按顺序展开的刀尖轨迹） */
export type SimPoint = { p: Pt; cut: boolean; stepIndex: number; contourId: string }

export function simulationPath(steps: JobStep[]): SimPoint[] {
  const out: SimPoint[] = []
  steps.forEach((st, si) => {
    // 空移落点（刀抬起）
    out.push({ p: st.startPt, cut: false, stepIndex: si, contourId: st.contourId })
    st.points.forEach((p) => {
      out.push({ p, cut: true, stepIndex: si, contourId: st.contourId })
    })
    if (st.closed) out.push({ p: st.points[0], cut: true, stepIndex: si, contourId: st.contourId })
  })
  return out
}