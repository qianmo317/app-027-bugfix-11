import type { Pt } from './types'
import { dist, lerp } from './geometry'

/** 2×3 仿射矩阵 [a, b, c, d, e, f]：x' = a·x + c·y + e, y' = b·x + d·y + f */
export type Mat = [number, number, number, number, number, number]

export const MAT_IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

export function matTranslate(tx: number, ty: number): Mat {
  return [1, 0, 0, 1, tx, ty]
}

export function matScale(sx: number, sy: number): Mat {
  return [sx, 0, 0, sy, 0, 0]
}

export function matMul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

export function matApply(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
}

export function matIsIdentity(m: Mat): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
}

export function parseTransform(str: string | null | undefined): Mat {
  if (!str) return MAT_IDENTITY
  let m: Mat = MAT_IDENTITY
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  let hit: RegExpExecArray | null
  while ((hit = re.exec(str)) !== null) {
    const name = hit[1]
    const nums = hit[2]
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map((s) => Number.parseFloat(s))
    let t: Mat = MAT_IDENTITY
    if (name === 'matrix' && nums.length >= 6) {
      t = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]]
    } else if (name === 'translate' && nums.length >= 1) {
      t = [1, 0, 0, 1, nums[0], nums[1] ?? 0]
    } else if (name === 'scale' && nums.length >= 1) {
      const sy = nums.length > 1 ? nums[1] : nums[0]
      t = [nums[0], 0, 0, sy, 0, 0]
    } else if (name === 'rotate' && nums.length >= 1) {
      const a = (nums[0] * Math.PI) / 180
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      const rot: Mat = [cos, sin, -sin, cos, 0, 0]
      if (nums.length >= 3) {
        const cx = nums[1]
        const cy = nums[2]
        t = matMul(matMul([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy])
      } else {
        t = rot
      }
    } else if (name === 'skewX' && nums.length >= 1) {
      t = [1, 0, Math.tan((nums[0] * Math.PI) / 180), 1, 0, 0]
    } else if (name === 'skewY' && nums.length >= 1) {
      t = [1, Math.tan((nums[0] * Math.PI) / 180), 0, 1, 0, 0]
    }
    m = matMul(m, t)
  }
  return m
}

export type SubPath = { points: Pt[]; closed: boolean }

// ---------------- 曲线离散化 ----------------

/** 三次贝塞尔自适应细分（按最大弦高误差 tol） */
function sampleCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number, out: Pt[], depth = 0): void {
  if (depth > 22) {
    out.push(p3)
    return
  }
  const chord = dist(p0, p3)
  const d1 = pointLineDistance(p1, p0, p3)
  const d2 = pointLineDistance(p2, p0, p3)
  const flat = Math.max(d1, d2)
  const polyLen = dist(p0, p1) + dist(p1, p2) + dist(p2, p3)
  if (flat <= tol && (chord <= tol || polyLen - chord <= tol * 4)) {
    out.push(p3)
    return
  }
  const mid = (a: Pt, b: Pt): Pt => lerp(a, b, 0.5)
  const p01 = mid(p0, p1)
  const p12 = mid(p1, p2)
  const p23 = mid(p2, p3)
  const p012 = mid(p01, p12)
  const p123 = mid(p12, p23)
  const p0123 = mid(p012, p123)
  sampleCubic(p0, p01, p012, p0123, tol, out, depth + 1)
  sampleCubic(p0123, p123, p23, p3, tol, out, depth + 1)
}

/** 外部使用：把三次贝塞尔离散化后追加到 out */
export function sampleCubicInto(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number, out: Pt[]): void {
  sampleCubic(p0, p1, p2, p3, tol, out)
}

function pointLineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l = Math.hypot(dx, dy)
  if (l < 1e-12) return dist(p, a)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / l
}

/** SVG 端点式圆弧 → 三次贝塞尔段序列 */
export function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Array<[Pt, Pt, Pt]> {
  if (rx === 0 || ry === 0) return []
  const phi = (phiDeg * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const dx2 = (x1 - x2) / 2
  const dy2 = (y1 - y2) / 2
  const x1p = cosPhi * dx2 + sinPhi * dy2
  const y1p = -sinPhi * dx2 + cosPhi * dy2
  let rxA = Math.abs(rx)
  let ryA = Math.abs(ry)
  const lambda = (x1p * x1p) / (rxA * rxA) + (y1p * y1p) / (ryA * ryA)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rxA *= s
    ryA *= s
  }
  const sign = largeArc !== sweep ? 1 : -1
  const numer = rxA * rxA * ryA * ryA - rxA * rxA * y1p * y1p - ryA * ryA * x1p * x1p
  const denom = rxA * rxA * y1p * y1p + ryA * ryA * x1p * x1p
  const co = sign * Math.sqrt(Math.max(0, numer / denom))
  const cxp = (co * rxA * y1p) / ryA
  const cyp = (-co * ryA * x1p) / rxA
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dotv = ux * vx + uy * vy
    const lenv = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let a = Math.acos(Math.max(-1, Math.min(1, dotv / (lenv || 1))))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const theta1 = angle(1, 0, (x1p - cxp) / rxA, (y1p - cyp) / ryA)
  let dTheta = angle((x1p - cxp) / rxA, (y1p - cyp) / ryA, (-x1p - cxp) / rxA, (-y1p - cyp) / ryA)
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI

  const segCount = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)))
  const delta = dTheta / segCount
  const t = ((4 / 3) * Math.tan(delta / 4)) as number
  const out: Array<[Pt, Pt, Pt]> = []
  let th = theta1
  for (let i = 0; i < segCount; i++) {
    const th2 = th + delta
    const cosT1 = Math.cos(th)
    const sinT1 = Math.sin(th)
    const cosT2 = Math.cos(th2)
    const sinT2 = Math.sin(th2)
    const e2 = (a: number, b: number): Pt => ({
      x: cosPhi * rxA * a - sinPhi * ryA * b + cx,
      y: sinPhi * rxA * a + cosPhi * ryA * b + cy,
    })
    const p1 = e2(cosT1 - t * sinT1, sinT1 + t * cosT1)
    const p2 = e2(cosT2 + t * sinT2, sinT2 - t * cosT2)
    const end = e2(cosT2, sinT2)
    out.push([p1, p2, end])
    th = th2
  }
  return out
}

/** 解析 SVG path 的 d 属性为子路径 */
export function parseSvgPath(d: string, tol = 0.15): SubPath[] {
  const subs: SubPath[] = []
  let points: Pt[] = []
  let closed = false
  let cur: Pt = { x: 0, y: 0 }
  let start: Pt = { x: 0, y: 0 }
  let prevCtrl: Pt | null = null
  let prevQCtrl: Pt | null = null
  let cmd = ''
  let i = 0
  const s = d

  const flush = () => {
    if (points.length >= 2) subs.push({ points, closed })
    points = []
    closed = false
  }

  const readNumber = (): number => {
    while (i < s.length && /[\s,]/.test(s[i])) i++
    const startI = i
    if (s[i] === '+' || s[i] === '-') i++
    while (i < s.length && /[0-9]/.test(s[i])) i++
    if (s[i] === '.') {
      i++
      while (i < s.length && /[0-9]/.test(s[i])) i++
    }
    if (s[i] === 'e' || s[i] === 'E') {
      i++
      if (s[i] === '+' || s[i] === '-') i++
      while (i < s.length && /[0-9]/.test(s[i])) i++
    }
    const text = s.slice(startI, i)
    const v = Number.parseFloat(text)
    return Number.isFinite(v) ? v : 0
  }

  const readFlag = (): boolean => {
    while (i < s.length && /[\s,]/.test(s[i])) i++
    const c = s[i]
    i++
    return c === '1'
  }

  const pushCurve = (p1: Pt, p2: Pt, p3: Pt) => {
    sampleCubic(cur, p1, p2, p3, tol, points)
    cur = p3
    prevCtrl = p2
  }

  const moveTo = (p: Pt) => {
    cur = p
    start = p
    points = [p]
  }

  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++
    if (i >= s.length) break
    const c = s[i]
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      cmd = c
      i++
    } else if (!/[0-9+\-.]/.test(c)) {
      i++
      continue
    } else if (cmd === '') {
      i++
      continue
    } else if (cmd === 'M') {
      cmd = 'L'
    } else if (cmd === 'm') {
      cmd = 'l'
    }

    const rel = cmd >= 'a' && cmd <= 'z'
    const up = cmd.toUpperCase()
    const ox = rel ? cur.x : 0
    const oy = rel ? cur.y : 0

    switch (up) {
      case 'M': {
        flush()
        const p = { x: readNumber() + ox, y: readNumber() + oy }
        moveTo(p)
        prevCtrl = null
        prevQCtrl = null
        break
      }
      case 'L': {
        const p = { x: readNumber() + ox, y: readNumber() + oy }
        if (points.length === 0) moveTo(cur)
        points.push(p)
        cur = p
        prevCtrl = null
        prevQCtrl = null
        break
      }
      case 'H': {
        const p = { x: readNumber() + ox, y: cur.y }
        if (points.length === 0) moveTo(cur)
        points.push(p)
        cur = p
        prevCtrl = null
        prevQCtrl = null
        break
      }
      case 'V': {
        const p = { x: cur.x, y: readNumber() + oy }
        if (points.length === 0) moveTo(cur)
        points.push(p)
        cur = p
        prevCtrl = null
        prevQCtrl = null
        break
      }
      case 'C': {
        const p1 = { x: readNumber() + ox, y: readNumber() + oy }
        const p2 = { x: readNumber() + ox, y: readNumber() + oy }
        const p3 = { x: readNumber() + ox, y: readNumber() + oy }
        if (points.length === 0) moveTo(cur)
        pushCurve(p1, p2, p3)
        prevQCtrl = null
        break
      }
      case 'S': {
        const p2 = { x: readNumber() + ox, y: readNumber() + oy }
        const p3 = { x: readNumber() + ox, y: readNumber() + oy }
        if (points.length === 0) moveTo(cur)
        const p1 = prevCtrl ? { x: 2 * cur.x - prevCtrl.x, y: 2 * cur.y - prevCtrl.y } : { ...cur }
        pushCurve(p1, p2, p3)
        prevQCtrl = null
        break
      }
      case 'Q': {
        const q = { x: readNumber() + ox, y: readNumber() + oy }
        const p3 = { x: readNumber() + ox, y: readNumber() + oy }
        if (points.length === 0) moveTo(cur)
        const p1 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) }
        const p2 = { x: p3.x + (2 / 3) * (q.x - p3.x), y: p3.y + (2 / 3) * (q.y - p3.y) }
        sampleCubic(cur, p1, p2, p3, tol, points)
        cur = p3
        prevQCtrl = q
        prevCtrl = p2
        break
      }
      case 'T': {
        const p3 = { x: readNumber() + ox, y: readNumber() + oy }
        if (points.length === 0) moveTo(cur)
        const q: Pt = prevQCtrl ? { x: 2 * cur.x - prevQCtrl.x, y: 2 * cur.y - prevQCtrl.y } : { ...cur }
        const p1 = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) }
        const p2 = { x: p3.x + (2 / 3) * (q.x - p3.x), y: p3.y + (2 / 3) * (q.y - p3.y) }
        sampleCubic(cur, p1, p2, p3, tol, points)
        cur = p3
        prevQCtrl = q
        prevCtrl = p2
        break
      }
      case 'A': {
        const rx = readNumber()
        const ry = readNumber()
        const rot = readNumber()
        const largeArc = readFlag()
        const sweep = readFlag()
        const p = { x: readNumber() + ox, y: readNumber() + oy }
        if (points.length === 0) moveTo(cur)
        const cubics = arcToCubics(cur.x, cur.y, rx, ry, rot, largeArc, sweep, p.x, p.y)
        if (cubics.length === 0) {
          points.push(p)
          cur = p
        } else {
          for (const [c1, c2, end] of cubics) {
            sampleCubic(cur, c1, c2, end, tol, points)
            cur = end
          }
          prevCtrl = null
        }
        prevQCtrl = null
        break
      }
      case 'Z': {
        closed = true
        if (points.length > 0) cur = { ...points[0] }
        flush()
        cur = start
        prevCtrl = null
        prevQCtrl = null
        break
      }
      default:
        i++
    }
  }
  flush()
  return subs
}

/** 点数组 → path d（用于 SVG 导出与缩略图） */
export function pointsToPathD(points: Pt[], closed: boolean, digits = 3): string {
  if (points.length === 0) return ''
  const f = (v: number) => {
    const r = Number(v.toFixed(digits))
    return String(r)
  }
  let d = `M${f(points[0].x)} ${f(points[0].y)}`
  for (let i = 1; i < points.length; i++) d += `L${f(points[i].x)} ${f(points[i].y)}`
  if (closed) d += 'Z'
  return d
}

/** 长为 1 的 SVG 长度字符串 → mm */
export function svgLengthToMm(value: string | null): number | null {
  if (!value) return null
  const m = /^\s*(-?[\d.]+)\s*(mm|cm|in|pt|pc|px)?\s*$/.exec(value)
  if (!m) return null
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  switch (m[2]) {
    case 'mm':
      return n
    case 'cm':
      return n * 10
    case 'in':
      return n * 25.4
    case 'pt':
      return (n * 25.4) / 72
    case 'pc':
      return (n * 25.4) / 6
    case 'px':
    case undefined:
      return (n * 25.4) / 96
    default:
      return n
  }
}