import type { Contour, ContourWarning, Pt } from './types'
import {
  cleanPoints,
  cyclicMatch,
  dist,
  duplicateKey,
  findSelfIntersections,
  polygonArea,
  polylineLength,
  round3,
  toCCW,
  uid,
} from './geometry'

export type RawSub = { points: Pt[]; closed: boolean }

export type CleanupOptions = { toleranceMm: number; closeToleranceMm: number }

/** 重复路径分组：kept 保留者，removed 被合并掉的（反向/完全重叠） */
export type DuplicateGroup = { kept: Contour; removed: Contour[] }

export type CleanupReport = {
  input: number
  kept: number
  dropped: number
  autoClosed: number
  duplicates: number
  notClosed: number
  selfIntersect: number
  duplicateGroups: DuplicateGroup[]
  /** 每个轮廓的自交点数量 */
  selfIntersections: Record<string, number>
}

export function makeContour(points: Pt[], closed: boolean, warnings: ContourWarning[] = []): Contour {
  const pts = points.map((p) => ({ x: round3(p.x), y: round3(p.y) }))
  return {
    id: uid('c'),
    points: pts,
    closed,
    area: closed ? polygonArea(pts) : 0,
    length: polylineLength(pts, closed),
    holes: [],
    bridges: [],
    warnings: [...warnings],
  }
}

/**
 * 路径清理：去重合点 / 共线点 → 闭合检查（近闭合自动闭合、未闭合打标）→
 * 重复路径合并（完全重叠或反向重叠）→ 自交检测
 */
export function cleanupContours(
  raw: RawSub[],
  opts: CleanupOptions,
): { contours: Contour[]; report: CleanupReport } {
  const report: CleanupReport = {
    input: raw.length,
    kept: 0,
    dropped: 0,
    autoClosed: 0,
    duplicates: 0,
    notClosed: 0,
    selfIntersect: 0,
    duplicateGroups: [],
    selfIntersections: {},
  }

  type Cand = { points: Pt[]; closed: boolean; warnings: ContourWarning[] }
  const cands: Cand[] = []

  for (const sub of raw) {
    if (sub.points.length < 2) {
      report.dropped += 1
      continue
    }
    let closed = sub.closed
    let pts = cleanPoints(sub.points, closed, 1e-4)
    if (!closed && pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) <= opts.closeToleranceMm) {
      pts = pts.slice(0, pts.length - 1)
      closed = true
      report.autoClosed += 1
    }
    if (closed) {
      if (pts.length < 3) {
        report.dropped += 1
        continue
      }
      pts = toCCW(pts)
    } else if (pts.length < 2) {
      report.dropped += 1
      continue
    }
    const warnings: ContourWarning[] = []
    if (!closed) {
      warnings.push('not_closed')
      report.notClosed += 1
    }
    cands.push({ points: pts, closed, warnings })
  }

  // 重复路径合并：先按几何指纹分组，再在组内做带容差的循环比对（含反向）
  const groups = new Map<string, number[]>()
  cands.forEach((c, i) => {
    const k = duplicateKey(c.points, c.closed)
    const arr = groups.get(k)
    if (arr) arr.push(i)
    else groups.set(k, [i])
  })
  const dupOf = new Map<number, number>()
  for (const arr of groups.values()) {
    if (arr.length < 2) continue
    for (let a = 0; a < arr.length; a++) {
      const ia = arr[a]
      if (dupOf.has(ia)) continue
      for (let b = a + 1; b < arr.length; b++) {
        const ib = arr[b]
        if (dupOf.has(ib)) continue
        if (cyclicMatch(cands[ia].points, cands[ib].points, 0.02)) {
          dupOf.set(ib, ia)
          report.duplicates += 1
        }
      }
    }
  }

  const contours: Contour[] = []
  const idByIndex = new Map<number, string>()
  const removedByKept = new Map<number, Contour[]>()
  cands.forEach((c, i) => {
    if (dupOf.has(i)) return
    const contour = makeContour(c.points, c.closed, c.warnings)
    idByIndex.set(i, contour.id)
    contours.push(contour)
  })
  for (const [removedIdx, keptIdx] of dupOf.entries()) {
    if (!idByIndex.has(keptIdx)) continue
    const removedContour = makeContour(cands[removedIdx].points, cands[removedIdx].closed, ['duplicate'])
    const list = removedByKept.get(keptIdx)
    if (list) list.push(removedContour)
    else removedByKept.set(keptIdx, [removedContour])
  }
  for (const [keptIdx, removed] of removedByKept.entries()) {
    const keptId = idByIndex.get(keptIdx)
    const target = contours.find((c) => c.id === keptId)
    if (!target) continue
    if (!target.warnings.includes('duplicate')) target.warnings.push('duplicate')
    report.duplicateGroups.push({ kept: target, removed })
  }

  // 自交检测
  for (const c of contours) {
    const hits = findSelfIntersections(c.points, c.closed)
    if (hits.length > 0) {
      c.warnings.push('self_intersect')
      report.selfIntersect += 1
      report.selfIntersections[c.id] = hits.length
    }
  }

  report.kept = contours.length
  return { contours, report }
}