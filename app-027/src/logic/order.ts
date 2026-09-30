import type { Pt } from './types'
import type { CutRun } from './bridges'
import type { NestingResult, TreeNode } from './nesting'
import { dist } from './geometry'

export type CutStep = {
  /** 切割顺序号（从 1 开始） */
  seq: number
  contourId: string
  runIndex: number
  runCount: number
  points: Pt[]
  closed: boolean
  startPt: Pt
  endPt: Pt
  /** 从上一段末尾跳到此段起点的距离（mm），第一段为 0 */
  travelFromPrevMm: number
  /** 包含层深（1 = 最外层） */
  level: number
  layer: number
  /** 该段长度（mm） */
  lengthMm: number
}

export type OrderResult = {
  steps: CutStep[]
  /** 跳刀总长（不含首次进刀接近） */
  travelMm: number
  /** 朴素顺序（未优化）的跳刀总长 */
  naiveTravelMm: number
  /** 优化比例（%） */
  improvementPct: number
  /** 首次进刀接近距离（mm） */
  approachMm: number
  naiveOrder: string[]
  optimizedOrder: string[]
}

export type OrderOptions = {
  optimize: 'nearest' | 'nearest_2opt'
  start: Pt
  layerOf?: (contourId: string) => number
}

type Endpoints = { start: Pt; end: Pt }

function runLength(points: Pt[], closed: boolean): number {
  let s = 0
  for (let i = 0; i + 1 < points.length; i++) s += dist(points[i], points[i + 1])
  if (closed && points.length > 2) s += dist(points[points.length - 1], points[0])
  return s
}

/** 最近邻：从 cursor 出发，依次挑最近的未访问轮廓 */
function nearestNeighbor(ids: string[], ep: Map<string, Endpoints>, cursor: Pt): string[] {
  const remaining = ids.slice()
  const out: string[] = []
  let cur = cursor
  while (remaining.length > 0) {
    let bestIdx = 0
    let bestD = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const e = ep.get(remaining[i])
      if (!e) continue
      const d = dist(cur, e.start)
      if (d < bestD) {
        bestD = d
        bestIdx = i
      }
    }
    const id = remaining.splice(bestIdx, 1)[0]
    out.push(id)
    cur = ep.get(id)?.end ?? cur
  }
  return out
}

/** 2-opt（开放路径）：反复尝试反转子序列，直到不再改善 */
function twoOpt(seq: string[], ep: Map<string, Endpoints>, cursor: Pt): string[] {
  const s = seq.slice()
  const n = s.length
  const startOf = (id: string): Pt => ep.get(id)?.start ?? cursor
  const endOf = (id: string): Pt => ep.get(id)?.end ?? cursor
  let improved = true
  let guard = 0
  while (improved && guard < 40) {
    improved = false
    guard += 1
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const prev = i > 0 ? endOf(s[i - 1]) : null
        const next = j < n - 1 ? startOf(s[j + 1]) : null
        const before = (prev ? dist(prev, startOf(s[i])) : dist(cursor, startOf(s[i]))) + (next ? dist(endOf(s[j]), next) : 0)
        const after = (prev ? dist(prev, startOf(s[j])) : dist(cursor, startOf(s[j]))) + (next ? dist(endOf(s[i]), next) : 0)
        if (after < before - 1e-9) {
          let lo = i
          let hi = j
          while (lo < hi) {
            const tmp = s[lo]
            s[lo] = s[hi]
            s[hi] = tmp
            lo += 1
            hi -= 1
          }
          improved = true
        }
      }
    }
  }
  return s
}

/**
 * 切割顺序：包含关系树 → 后序遍历（先内后外）；
 * 同层轮廓按最近邻 + 2-opt 排序以缩短跳刀。
 */
export function orderCut(
  runsOf: Map<string, CutRun[]>,
  tree: NestingResult,
  opts: OrderOptions,
): OrderResult {
  const ep = new Map<string, Endpoints>()
  for (const [id, runs] of runsOf.entries()) {
    if (runs.length === 0) continue
    ep.set(id, { start: runs[0].points[0], end: runs[runs.length - 1].points[runs[runs.length - 1].points.length - 1] })
  }

  const naive: string[] = []
  const optimized: string[] = []

  const walkNaive = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      walkNaive(node.children)
      if (ep.has(node.id)) naive.push(node.id)
    }
  }
  walkNaive(tree.roots)

  const walkOptimized = (nodes: TreeNode[]): void => {
    const ids = nodes.filter((n) => ep.has(n.id)).map((n) => n.id)
    const inner = nodes.filter((n) => !ep.has(n.id))
    let seq = ids.slice()
    if (opts.optimize === 'nearest_2opt' && seq.length > 2) {
      seq = twoOpt(nearestNeighbor(ids, ep, cursorPos), ep, cursorPos)
    } else if (seq.length > 1) {
      seq = nearestNeighbor(ids, ep, cursorPos)
    }
    for (const id of seq) {
      const node = nodes.find((n) => n.id === id)
      if (node) walkOptimized(node.children)
      for (const run of runsOf.get(id) ?? []) {
        cursorPos = run.points[run.points.length - 1]
      }
      optimized.push(id)
    }
    for (const node of inner) walkOptimized(node.children)
  }

  let cursorPos: Pt = opts.start
  walkOptimized(tree.roots)

  const buildSteps = (order: string[], withTravel: boolean): CutStep[] => {
    const out: CutStep[] = []
    let cursor: Pt = opts.start
    let first = true
    let seqNo = 0
    for (const id of order) {
      const runs = runsOf.get(id) ?? []
      for (let r = 0; r < runs.length; r++) {
        const run = runs[r]
        const startPt = run.points[0]
        const endPt = run.points[run.points.length - 1]
        seqNo += 1
        out.push({
          seq: seqNo,
          contourId: id,
          runIndex: r,
          runCount: runs.length,
          points: run.points,
          closed: run.closed,
          startPt,
          endPt,
          travelFromPrevMm: withTravel && !first ? dist(cursor, startPt) : 0,
          level: tree.depthOf.get(id) ?? 1,
          layer: opts.layerOf ? opts.layerOf(id) : 0,
          lengthMm: runLength(run.points, run.closed),
        })
        cursor = endPt
        first = false
      }
    }
    return out
  }

  const naiveSteps = buildSteps(naive, true)
  const optimizedSteps = buildSteps(optimized, true)
  // 优化后反而更长（同层顺序本来就是顺路的）时回退到朴素顺序
  const useOptimized = sumTravel(optimizedSteps) <= sumTravel(naiveSteps) + 1e-9
  const stepsFinal = useOptimized ? optimizedSteps : naiveSteps
  const travelMm = sumTravel(stepsFinal)
  const naiveTravelMm = sumTravel(naiveSteps)
  const approachMm = stepsFinal.length > 0 ? dist(opts.start, stepsFinal[0].startPt) : 0
  const improvementPct = naiveTravelMm > 1e-9 ? ((naiveTravelMm - travelMm) / naiveTravelMm) * 100 : 0

  return {
    steps: stepsFinal,
    travelMm,
    naiveTravelMm,
    improvementPct,
    approachMm,
    naiveOrder: naive,
    optimizedOrder: useOptimized ? optimized : naive,
  }
}

export function sumTravel(steps: CutStep[]): number {
  let s = 0
  for (const st of steps) s += st.travelFromPrevMm
  return s
}