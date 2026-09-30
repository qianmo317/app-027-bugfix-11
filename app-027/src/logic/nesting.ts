import type { Contour } from './types'
import { boundsContain, boundsOf, interiorPoint, pointInPolygon } from './geometry'

export type TreeNode = {
  id: string
  depth: number
  parentId: string | null
  children: TreeNode[]
}

export type NestingResult = {
  roots: TreeNode[]
  nodeById: Map<string, TreeNode>
  depthOf: Map<string, number>
  /** 轮廓包含关系树的最大嵌套层数（最外层记为 1） */
  maxDepth: number
  /** 判定为「在某个轮廓内部」的轮廓数 */
  nestedCount: number
}

/**
 * 包含关系树：面积大者为父，用「点在多边形内 + 面积排序」判定直接父子。
 * 嵌套 3 层以上同样正确（同心三层窗花 → depth 1/2/3）。
 */
export function buildContainmentTree(contours: Contour[]): NestingResult {
  const nodeById = new Map<string, TreeNode>()
  const depthOf = new Map<string, number>()
  const parentOf = new Map<string, string | null>()

  const items = contours.map((c) => ({
    c,
    bounds: boundsOf(c.points),
    rep: c.closed && c.points.length >= 3 ? interiorPoint(c.points) : null,
    area: c.closed ? c.area : 0,
  }))
  // 面积升序：找父级时从最小的候选开始，遇到第一个包含自己的即为直接父级
  const byAreaAsc = items.slice().sort((a, b) => a.area - b.area)

  for (const it of items) {
    parentOf.set(it.c.id, null)
    if (!it.rep) continue
    // 升序遍历：第一个「面积更大且包含我」的轮廓就是直接父级
    for (const cand of byAreaAsc) {
      if (cand.c.id === it.c.id) continue
      if (!cand.rep) continue
      if (cand.area <= it.area * 1.0001) continue
      if (!boundsContain(cand.bounds, it.bounds, 1e-6)) continue
      if (!pointInPolygon(it.rep, cand.c.points)) continue
      parentOf.set(it.c.id, cand.c.id)
      break
    }
  }

  for (const c of contours) {
    const node: TreeNode = { id: c.id, depth: 1, parentId: parentOf.get(c.id) ?? null, children: [] }
    nodeById.set(c.id, node)
  }
  const roots: TreeNode[] = []
  for (const c of contours) {
    const node = nodeById.get(c.id) as TreeNode
    const pid = node.parentId
    if (pid) {
      const parent = nodeById.get(pid)
      if (parent) parent.children.push(node)
      else roots.push(node)
    } else {
      roots.push(node)
    }
  }
  // 深度：父 + 1
  const assign = (node: TreeNode, depth: number): void => {
    node.depth = depth
    depthOf.set(node.id, depth)
    for (const ch of node.children) assign(ch, depth + 1)
  }
  for (const r of roots) assign(r, 1)

  // 写回 holes（直接子轮廓）
  for (const c of contours) {
    const node = nodeById.get(c.id)
    c.holes = node ? node.children.map((n) => n.id) : []
  }

  let maxDepth = 0
  for (const d of depthOf.values()) maxDepth = Math.max(maxDepth, d)

  return {
    roots,
    nodeById,
    depthOf,
    maxDepth,
    nestedCount: contours.filter((c) => (parentOf.get(c.id) ?? null) !== null).length,
  }
}