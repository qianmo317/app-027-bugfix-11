import type { Pt } from './types'

/** 浮点保留 3 位小数（内部一律 mm） */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

export function round(v: number, digits = 3): number {
  const f = Math.pow(10, digits)
  return Math.round(v * f) / f
}

export const EPS = 1e-9

export function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function add(a: Pt, b: Pt): Pt {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function mul(a: Pt, k: number): Pt {
  return { x: a.x * k, y: a.y * k }
}

export function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y
}

export function cross(a: Pt, b: Pt): number {
  return a.x * b.y - a.y * b.x
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function dist2(a: Pt, b: Pt): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

export function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** 鞋带公式有符号面积（闭合多边形，逆时针为正） */
export function signedArea(pts: Pt[]): number {
  const n = pts.length
  if (n < 3) return 0
  let s = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

export function polygonArea(pts: Pt[]): number {
  return Math.abs(signedArea(pts))
}

/** 多边形周长（闭合） */
export function polygonPerimeter(pts: Pt[]): number {
  const n = pts.length
  if (n < 2) return 0
  let s = 0
  for (let i = 0; i < n; i++) s += dist(pts[i], pts[(i + 1) % n])
  return s
}

/** 折线长度（不闭合时不含首尾连线） */
export function polylineLength(pts: Pt[], closed: boolean): number {
  if (pts.length < 2) return 0
  let s = 0
  for (let i = 0; i + 1 < pts.length; i++) s += dist(pts[i], pts[i + 1])
  if (closed) s += dist(pts[pts.length - 1], pts[0])
  return s
}

export function centroid(pts: Pt[]): Pt {
  const n = pts.length
  if (n === 0) return { x: 0, y: 0 }
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    const f = p.x * q.y - q.x * p.y
    a += f
    cx += (p.x + q.x) * f
    cy += (p.y + q.y) * f
  }
  if (Math.abs(a) < 1e-12) {
    // 退化：取平均点
    let sx = 0
    let sy = 0
    for (const p of pts) {
      sx += p.x
      sy += p.y
    }
    return { x: sx / n, y: sy / n }
  }
  a *= 0.5
  return { x: cx / (6 * a), y: cy / (6 * a) }
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

export function boundsOf(pts: Pt[]): Bounds {
  if (pts.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

export function mergeBounds(list: Bounds[]): Bounds {
  if (list.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  const r = { ...list[0] }
  for (const b of list) {
    r.minX = Math.min(r.minX, b.minX)
    r.minY = Math.min(r.minY, b.minY)
    r.maxX = Math.max(r.maxX, b.maxX)
    r.maxY = Math.max(r.maxY, b.maxY)
  }
  return r
}

export function boundsContain(a: Bounds, b: Bounds, pad = 0): boolean {
  return (
    b.minX >= a.minX - pad && b.minY >= a.minY - pad && b.maxX <= a.maxX + pad && b.maxY <= a.maxY + pad
  )
}

/** 射线法：点是否在多边形内部（closed 轮廓） */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
      if (p.x < x) inside = !inside
    }
  }
  return inside
}

/** 取多边形上一点可靠落在内部的代表点（用质心，退化时用顶点向内偏移） */
export function interiorPoint(pts: Pt[]): Pt {
  const c = centroid(pts)
  if (pointInPolygon(c, pts)) return c
  // 退化/凹形：取边中点向内部法线方向微移
  const n = pts.length
  const sx = signedArea(pts) >= 0 ? 1 : -1
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const m = lerp(a, b, 0.5)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    const cand = { x: m.x + (-dy / l) * 0.01 * sx, y: m.y + (dx / l) * 0.01 * sx }
    if (pointInPolygon(cand, pts)) return cand
  }
  return c
}

export type SegIntersection = { ai: number; bi: number; p: Pt }

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/**
 * 线段求交（含共线重叠），返回交点；不平行且相交才返回。
 * eps 为坐标容差。
 */
export function segIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt, eps = 1e-7): Pt | null {
  const d1 = orient(p3, p4, p1)
  const d2 = orient(p3, p4, p2)
  const d3 = orient(p1, p2, p3)
  const d4 = orient(p1, p2, p4)

  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) {
    const t = d1 / (d1 - d2)
    return { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t }
  }

  // 共线重叠
  if (Math.abs(d1) <= eps && Math.abs(d2) <= eps && Math.abs(d3) <= eps && Math.abs(d4) <= eps) {
    const along = (a: Pt, b: Pt) => (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)
    if (along(p1, p2) < eps || along(p3, p4) < eps) return null
    const axis = p2.x - p1.x !== 0 ? 'x' : 'y'
    const q = [p1[axis], p2[axis]].sort((a, b) => a - b)
    const r = [p3[axis], p4[axis]].sort((a, b) => a - b)
    const lo = Math.max(q[0], r[0])
    const hi = Math.min(q[1], r[1])
    if (hi - lo < 1e-6) return null
    const mid = (lo + hi) / 2
    const t = axis === 'x' ? (mid - p1.x) / (p2.x - p1.x || 1) : (mid - p1.y) / (p2.y - p1.y || 1)
    return { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t }
  }
  return null
}

type Seg = { a: Pt; b: Pt; i: number }

function segmentsOf(pts: Pt[], closed: boolean): Seg[] {
  const segs: Seg[] = []
  const n = pts.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) segs.push({ a: pts[i], b: pts[(i + 1) % n], i })
  return segs
}

/**
 * 自交检测：空间网格加速，返回互不相邻的线段交点（已去重）。
 * 对 5000 点轮廓也能在毫秒级完成。
 */
export function findSelfIntersections(pts: Pt[], closed: boolean): SegIntersection[] {
  const segs = segmentsOf(pts, closed)
  const m = segs.length
  if (m < 3) return []

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let totalLen = 0
  for (const s of segs) {
    minX = Math.min(minX, s.a.x, s.b.x)
    minY = Math.min(minY, s.a.y, s.b.y)
    maxX = Math.max(maxX, s.a.x, s.b.x)
    maxY = Math.max(maxY, s.a.y, s.b.y)
    totalLen += dist(s.a, s.b)
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1
  const cell = Math.max(diag / 160, totalLen / m / 2, 1e-4)

  const grid = new Map<number, number[]>()
  const key = (cx: number, cy: number) => cy * 100000 + cx
  for (let i = 0; i < m; i++) {
    const s = segs[i]
    const x0 = Math.floor((Math.min(s.a.x, s.b.x) - minX) / cell)
    const x1 = Math.floor((Math.max(s.a.x, s.b.x) - minX) / cell)
    const y0 = Math.floor((Math.min(s.a.y, s.b.y) - minY) / cell)
    const y1 = Math.floor((Math.max(s.a.y, s.b.y) - minY) / cell)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy)
        const arr = grid.get(k)
        if (arr) arr.push(i)
        else grid.set(k, [i])
      }
    }
  }
  const tested = new Set<number>()
  const out: SegIntersection[] = []
  for (const arr of grid.values()) {
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        const i = arr[x]
        const j = arr[y]
        const pk = i < j ? i * m + j : j * m + i
        if (tested.has(pk)) continue
        tested.add(pk)
        // 相邻线段共享端点，跳过
        if (closed) {
          if ((i + 1) % m === j || (j + 1) % m === i) continue
        } else if (i + 1 === j || j + 1 === i) continue
        const p = segIntersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b)
        if (p) out.push({ ai: i, bi: j, p })
      }
    }
  }
  return out
}

/** 去掉重合的相邻点与共线点，返回新数组（不修改原数组） */
export function cleanPoints(pts: Pt[], closed: boolean, tol = 1e-4): Pt[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }))
  const out: Pt[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || dist(last, p) > tol) out.push({ x: p.x, y: p.y })
  }
  if (closed && out.length > 1 && dist(out[0], out[out.length - 1]) <= tol) out.pop()

  // 共线点
  const res: Pt[] = []
  const n = out.length
  for (let i = 0; i < n; i++) {
    const prev = out[(i - 1 + n) % n]
    const cur = out[i]
    const next = out[(i + 1) % n]
    if (!closed && (i === 0 || i === n - 1)) {
      res.push(cur)
      continue
    }
    const cr = Math.abs(orient(prev, cur, next))
    const len = dist(prev, next)
    if (len > 1e-9 && cr / len < 1e-5) continue
    res.push(cur)
  }
  return res.length >= 3 || !closed ? res : out
}

/** 按弧长取点（closed 时会跨越首尾） */
export function pointAtArcLength(pts: Pt[], closed: boolean, s: number): Pt {
  const n = pts.length
  if (n === 0) return { x: 0, y: 0 }
  if (n === 1) return { ...pts[0] }
  const segCount = closed ? n : n - 1
  let remain = s
  for (let i = 0; i < segCount; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const l = dist(a, b)
    if (remain <= l) return lerp(a, b, l > 0 ? remain / l : 0)
    remain -= l
  }
  return { ...pts[closed ? 0 : n - 1] }
}

/** 点到折线的最近投影：返回 { index, t, point, distance } */
export function closestOnPolyline(
  p: Pt,
  pts: Pt[],
  closed: boolean,
): { index: number; t: number; point: Pt; distance: number } {
  const n = pts.length
  const segCount = closed ? n : n - 1
  let best = { index: 0, t: 0, point: { ...p }, distance: Infinity }
  for (let i = 0; i < segCount; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
    t = Math.max(0, Math.min(1, t))
    const q = { x: a.x + dx * t, y: a.y + dy * t }
    const d = dist(p, q)
    if (d < best.distance) best = { index: i, t, point: q, distance: d }
  }
  return best
}

/** 有符号面积转逆时针（CCW） */
export function toCCW(pts: Pt[]): Pt[] {
  return signedArea(pts) >= 0 ? pts : pts.slice().reverse()
}

/**
 * 循环比较两条点序列是否相同（允许不同起点与反向），容差 tol（mm）。
 * 仅用于「同 bbox / 同面积 / 同周长」候选组内的精确比对，成本可控。
 */
export function cyclicMatch(a: Pt[], b: Pt[], tol: number): boolean {
  if (a.length !== b.length || a.length === 0) return false
  const n = a.length
  for (let off = 0; off < n; off++) {
    if (dist(a[0], b[off]) > tol) continue
    let ok = true
    for (let i = 1; i < n; i++) {
      if (dist(a[i], b[(off + i) % n]) > tol) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  // 反向
  const rb = b.slice().reverse()
  for (let off = 0; off < n; off++) {
    if (dist(a[0], rb[off]) > tol) continue
    let ok = true
    for (let i = 1; i < n; i++) {
      if (dist(a[i], rb[(off + i) % n]) > tol) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** 重复路径候选键：同 bbox（0.01mm）+ 面积/周长（0.01）+ 点数 */
export function duplicateKey(pts: Pt[], closed: boolean): string {
  const b = boundsOf(pts)
  const a = closed ? polygonArea(pts) : 0
  const l = polylineLength(pts, closed)
  return [
    Math.round(b.minX * 100),
    Math.round(b.minY * 100),
    Math.round(b.maxX * 100),
    Math.round(b.maxY * 100),
    Math.round(a * 100),
    Math.round(l * 100),
    pts.length,
  ].join('|')
}

let uidSeq = 0
export function uid(prefix = 'id'): string {
  uidSeq += 1
  return `${prefix}_${uidSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

export function bboxOverlaps(a: Bounds, b: Bounds, eps = 1e-6): boolean {
  return !(a.maxX < b.minX - eps || b.maxX < a.minX - eps || a.maxY < b.minY - eps || b.maxY < a.minY - eps)
}