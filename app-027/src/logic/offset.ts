import type { Pt } from './types'
import { dist, findSelfIntersections, polygonArea, signedArea } from './geometry'
import type { CutRun } from './bridges'

export type OffsetResult = {
  runs: CutRun[]
  /** false → 未能安全偏置，调用方应保留原路径并明确警告 */
  ok: boolean
  /** 是否做过自交裁剪（凹角处会产生自交环） */
  clipped: boolean
  message: string
}

function edgeNormal(a: Pt, b: Pt, sign: number): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l = Math.hypot(dx, dy) || 1
  return { x: (dy / l) * sign, y: (-dx / l) * sign }
}

/**
 * 多边形等距偏置（miter 连接 + bevel 兜底），
 * 然后对凹角产生的自交环做裁剪；裁剪不干净时返回 ok=false 由调用方警告。
 */
export function offsetPolygon(pts: Pt[], signedDist: number): OffsetResult {
  const original: CutRun[] = [{ points: pts, closed: true }]
  if (pts.length < 3 || Math.abs(signedDist) < 1e-6) {
    return { runs: original, ok: true, clipped: false, message: '未启用刀补' }
  }
  const area = signedArea(pts)
  const sign = area >= 0 ? 1 : -1
  const n = pts.length
  const d = signedDist
  const miterLimit = Math.abs(d) * 10

  const raw: Pt[] = []
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]
    const cur = pts[i]
    const next = pts[(i + 1) % n]
    const n1 = edgeNormal(prev, cur, sign)
    const n2 = edgeNormal(cur, next, sign)
    // 两条偏移直线求交（用同向法线合并）
    const up = { x: cur.x - prev.x, y: cur.y - prev.y }
    const vp = { x: n1.x * d, y: n1.y * d }
    const uq = { x: next.x - cur.x, y: next.y - cur.y }
    const vq = { x: n2.x * d, y: n2.y * d }
    const denom = up.x * uq.y - up.y * uq.x
    if (Math.abs(denom) < 1e-9) {
      raw.push({ x: cur.x + n1.x * d, y: cur.y + n1.y * d })
      continue
    }
    const t = ((cur.x + vq.x - (cur.x + vp.x)) * uq.y - (cur.y + vq.y - (cur.y + vp.y)) * uq.x) / denom
    const ip = { x: cur.x + vp.x + up.x * t, y: cur.y + vp.y + up.y * t }
    if (dist(ip, cur) > miterLimit) {
      // 尖角超出 miter 限制 → bevel：两个独立偏移点
      raw.push({ x: cur.x + n1.x * d, y: cur.y + n1.y * d })
      raw.push({ x: cur.x + n2.x * d, y: cur.y + n2.y * d })
    } else {
      raw.push(ip)
    }
  }

  const wantSign = sign
  const loops = splitLoops(raw, 0)
  const kept: Pt[][] = []
  let dropped = 0
  for (const loop of loops) {
    if (loop.length < 3) {
      dropped += 1
      continue
    }
    const sa = signedArea(loop)
    const same = (sa >= 0 ? 1 : -1) === wantSign
    if (!same) {
      dropped += 1
      continue
    }
    if (polygonArea(loop) < 0.01) {
      dropped += 1
      continue
    }
    if (findSelfIntersections(loop, true).length > 0) {
      dropped += 1
      continue
    }
    kept.push(loop)
  }

  if (kept.length === 0) {
    return {
      runs: original,
      ok: false,
      clipped: dropped > 0,
      message: `刀补 ${d.toFixed(2)}mm 偏置后轮廓消失（凹角自交无法裁剪），已保留原路径，请减小刀补量`,
    }
  }

  const clipped = loops.length > 1 || dropped > 0
  return {
    runs: kept.map((k) => ({ points: k, closed: true })),
    ok: true,
    clipped,
    message: clipped
      ? `刀补 ${d.toFixed(2)}mm：裁剪掉 ${dropped} 段自交环，保留 ${kept.length} 段可切路径`
      : `刀补 ${d.toFixed(2)}mm 已应用，无自交`,
  }
}

/** 把自交多边形拆成简单环（递归） */
function splitLoops(poly: Pt[], depth: number): Pt[][] {
  if (depth > 14 || poly.length < 3) return [poly]
  const hits = findSelfIntersections(poly, true)
  if (hits.length === 0) return [poly]
  const hit = hits[0]
  const p = { x: Math.round(hit.p.x * 1000) / 1000, y: Math.round(hit.p.y * 1000) / 1000 }
  // 确认交点确实落在两条线段上（避免浮点误差造成的假交点）
  if (!onSegment(p, poly[hit.ai], poly[(hit.ai + 1) % poly.length])) return [poly]

  const a = Math.min(hit.ai, hit.bi)
  const b = Math.max(hit.ai, hit.bi)
  const withFirst = poly.slice()
  withFirst.splice(a + 1, 0, p)
  const withBoth = withFirst.slice()
  const bShift = b + 1
  withBoth.splice(bShift + 1, 0, p)
  const i1 = a + 1
  const i2 = bShift + 1
  if (i2 <= i1) return [poly]

  const loop1 = withBoth.slice(i1, i2 + 1)
  const loop2 = withBoth.slice(i2).concat(withBoth.slice(0, i1 + 1))
  const out: Pt[][] = []
  for (const lp of [loop1, loop2]) {
    if (lp.length < 3) continue
    out.push(...splitLoops(dedupeConsecutive(lp), depth + 1))
  }
  return out.length > 0 ? out : [poly]
}

function dedupeConsecutive(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || dist(last, p) > 1e-9) out.push(p)
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) < 1e-9) out.pop()
  return out
}

function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  const l = Math.hypot(b.x - a.x, b.y - a.y)
  if (l < 1e-12) return dist(p, a) < 1e-6
  if (Math.abs(cross) / l > 1e-6) return false
  return p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 && p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6
}