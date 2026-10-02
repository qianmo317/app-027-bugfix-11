/* 持久化回归测试：模拟浏览器环境，验证
 * 1) 改名 / 调规则 / 加纹样后刷新（重载）不丢
 * 2) 多项目全部读回（旧 bug：只读 projects[0]）
 * 3) 旧数据缺字段自动补齐（settings/export/sheet/batch/layerNames、轮廓 area/length/bridges/warnings/holes）
 * 4) 补齐后连刀点正常生成、问题清单可遍历
 * 5) 副本深拷贝：新编号、改副本不影响原件、派生缓存各自独立、holes/batchShapeId 重映射
 * 6) 自定义材料预设随项目库一起保存 / 恢复
 */
import {
  state,
  loadState,
  saveNow,
  createProjectFromShapes,
  duplicateProject,
  getProject,
  updateSettings,
  addShape,
  upsertMaterial,
  computedOf,
  touch,
} from '@/logic/store'
import { makeContour } from '@/logic/cleanup'
import { uid } from '@/logic/geometry'
import type { MaterialPreset } from '@/logic/types'

// ---- 浏览器环境桩 ----
const ls = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, String(v)),
  removeItem: (k: string) => void ls.delete(k),
  clear: () => ls.clear(),
}
;(globalThis as Record<string, unknown>).window = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  addEventListener: () => {},
}

const LS_KEY = 'papercut-plotter-studio/v1'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** 模拟浏览器刷新：丢掉内存状态，重新从 localStorage 读 */
function reload(): void {
  state.ready = false
  state.projects = []
  state.materials = []
  loadState()
}

async function main(): Promise<void> {
  // ============ 场景 1：旧数据（缺字段 + 多项目）读回 ============
  console.log('场景 1：旧数据缺字段补齐 + 多项目全部读回')
  const oldData = {
    version: 1,
    materials: [{ id: 'mat-xuan', name: '宣纸精细（轻压多遍）' }], // 缺 force/speed 等
    projects: [
      {
        id: 'p_old1',
        name: '旧项目一',
        // 缺 createdAt/updatedAt/settings/export/sheet/materialId/layerNames/batch
        shapes: [
          {
            id: 's_old1',
            name: '旧形状',
            // 缺 layer
            contours: [
              {
                id: 'c_old1',
                points: [
                  { x: 0, y: 0 },
                  { x: 40, y: 0 },
                  { x: 40, y: 40 },
                  { x: 0, y: 40 },
                ],
                closed: true,
                // 缺 area/length/holes/bridges/warnings
              },
            ],
          },
        ],
      },
      { id: 'p_old2', name: '旧项目二', shapes: [] },
      { id: 'p_old3', name: '旧项目三', shapes: [] },
    ],
  }
  ls.set(LS_KEY, JSON.stringify(oldData))

  loadState()
  check('ready 标志置位', state.ready)
  check('3 个项目全部读回（不是只读第一个）', state.projects.length === 3, `实际 ${state.projects.length}`)

  const p1 = getProject('p_old1')!
  check('切割规则补齐（bridgeWidthMm=0.5）', p1.settings.bridgeWidthMm === 0.5, `实际 ${p1.settings.bridgeWidthMm}`)
  check('切割规则补齐（bridgeRule=by_area）', p1.settings.bridgeRule === 'by_area')
  check('导出配置补齐（format=plt）', p1.export.format === 'plt')
  check('纸幅补齐（A4 210×297）', p1.sheet.widthMm === 210 && p1.sheet.heightMm === 297)
  check('批量排版配置补齐', !!p1.batch && p1.batch.enabled === false && p1.batch.rows === 2)
  check('图层名补齐', p1.layerNames.length === 1 && p1.layerNames[0] === '图层 1')
  check('材料引用有效', p1.materialId === 'mat-xuan', `实际 ${p1.materialId}`)

  const c1 = p1.shapes[0].contours[0]
  check('轮廓 bridges 补齐为数组', Array.isArray(c1.bridges))
  check('轮廓 warnings 补齐为数组', Array.isArray(c1.warnings))
  check('轮廓 holes 补齐为数组', Array.isArray(c1.holes))
  check('派生面积重算（≈1600）', Math.abs(c1.area - 1600) < 1e-6, `实际 ${c1.area}`)
  check('派生周长重算（≈160）', Math.abs(c1.length - 160) < 1e-6, `实际 ${c1.length}`)

  const comp1 = computedOf('s_old1')
  check('重算不抛错且有结果', comp1 !== null)
  check('连刀点正常生成（画布上有连刀点）', (comp1?.stats.bridgeCount ?? 0) > 0, `实际 ${comp1?.stats.bridgeCount}`)
  check('嵌套层数可算（maxDepth ≥ 1）', (comp1?.stats.maxDepth ?? 0) >= 1)
  let warningsIterOk = true
  try {
    for (const s of p1.shapes) for (const c of s.contours) for (const w of c.warnings) void w
  } catch {
    warningsIterOk = false
  }
  check('问题清单可遍历（不整块报错）', warningsIterOk)

  check('自定义材料随库恢复', state.materials.length === 1 && state.materials[0].id === 'mat-xuan')
  check('材料缺省字段补齐（force>0）', state.materials[0].force > 0)

  // 补齐后的数据应立刻写回本机
  await sleep(300)
  const persisted1 = JSON.parse(ls.get(LS_KEY)!) as { projects: Array<{ id: string; batch?: unknown; settings?: { bridgeWidthMm?: number } }> }
  check('补齐后的数据已写回本机（batch 字段存在）', persisted1.projects.some((p) => p.id === 'p_old1' && p.batch != null))
  check(
    '写回的数据含切割规则',
    persisted1.projects.find((p) => p.id === 'p_old1')?.settings?.bridgeWidthMm === 0.5,
  )

  // ============ 场景 2：改名 / 调规则 / 加纹样 → 刷新不丢 ============
  console.log('场景 2：改动立刻写本机，刷新后仍在')
  const p2 = getProject('p_old2')!
  p2.name = '改名后的项目'
  touch(p2)
  updateSettings(p1, { bridgeWidthMm: 0.8, bridgeRule: 'by_length' })
  addShape(p1, { id: uid('s'), name: '新加的纹样', contours: [makeContour([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], true)], layer: 0 })
  const customMat: MaterialPreset = { id: 'mat-custom', name: '自建材料', paper: 'xuan', force: 66, speedMmS: 55, passes: 2, bladeOffsetMm: 0.2, backing: '白色软垫板' }
  upsertMaterial(customMat)
  await sleep(300) // 等防抖落盘

  reload()
  const rp1 = getProject('p_old1')!
  const rp2 = getProject('p_old2')!
  check('改名刷新后仍在', rp2.name === '改名后的项目', `实际 ${rp2.name}`)
  check('切割规则刷新后仍在', rp1.settings.bridgeWidthMm === 0.8 && rp1.settings.bridgeRule === 'by_length')
  check('新加纹样刷新后仍在', rp1.shapes.length === 2 && rp1.shapes.some((s) => s.name === '新加的纹样'))
  check('自建材料刷新后仍在', state.materials.some((m) => m.id === 'mat-custom' && m.force === 66))
  check('另一个项目（p_old3）也没丢', !!getProject('p_old3'))

  // ============ 场景 3：副本独立 ============
  console.log('场景 3：副本与原件各算各的')
  // 造一个带嵌套（外框含内孔）的项目，验证 holes 重映射
  const inner = makeContour([{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }], true)
  const outer = makeContour([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }], true)
  const proj = createProjectFromShapes('原件', [{ id: uid('s'), name: '嵌套形', contours: [outer, inner], layer: 0 }])
  proj.batchShapeId = proj.shapes[0].id
  // 触发一次重算，让 holes 写入数据模型
  await sleep(0)
  const srcOuter = proj.shapes[0].contours.find((c) => c.id === outer.id)!
  check('原件 holes 已写入（外框含内孔）', srcOuter.holes.includes(inner.id), `实际 ${JSON.stringify(srcOuter.holes)}`)

  const copy = duplicateProject(proj.id)!
  check('副本有自己的项目编号', copy.id !== proj.id)
  check('副本形状有自己的编号', copy.shapes[0].id !== proj.shapes[0].id)
  const copyOuter = copy.shapes[0].contours[0]
  const copyInner = copy.shapes[0].contours[1]
  check('副本轮廓有自己的编号', copyOuter.id !== outer.id && copyInner.id !== inner.id)
  check('副本 holes 重映射到自己的轮廓', copyOuter.holes.length === 1 && copyOuter.holes[0] === copyInner.id, `实际 ${JSON.stringify(copyOuter.holes)}`)
  check('副本 batchShapeId 指向自己的形状', copy.batchShapeId === copy.shapes[0].id, `实际 ${copy.batchShapeId}`)
  check('副本设置是独立对象', copy.settings !== proj.settings && copy.settings.bridgeWidthMm === proj.settings.bridgeWidthMm)

  // 改副本 → 原件不能跟着变
  copy.shapes[0].name = '副本改过的形状'
  copy.shapes[0].contours[0].bridges.push({ atIndex: 1, widthMm: 0.5 })
  copy.settings.bridgeWidthMm = 1.5
  check('改副本形状名，原件不变', proj.shapes[0].name === '嵌套形')
  check('改副本连刀点，原件不变', proj.shapes[0].contours[0].bridges.length === 0)
  check('改副本规则，原件不变', proj.settings.bridgeWidthMm !== 1.5)

  // 派生数据各自独立（嵌套层数 / 连刀点各算各的）
  const srcComp = computedOf(proj.shapes[0].id)
  const copyComp = computedOf(copy.shapes[0].id)
  check('副本有自己的派生结果', !!srcComp && !!copyComp && srcComp !== copyComp)
  check('副本嵌套层数正确（2 层）', copyComp?.stats.maxDepth === 2, `实际 ${copyComp?.stats.maxDepth}`)

  // 副本随保存 / 刷新也保持独立
  await sleep(300)
  reload()
  const rProj = state.projects.find((p) => p.name === '原件')!
  const rCopy = state.projects.find((p) => p.name === '原件 副本')!
  check('刷新后原件与副本都在', !!rProj && !!rCopy)
  check('刷新后副本仍用自己的编号', rCopy.id === copy.id && rCopy.shapes[0].id === copy.shapes[0].id)
  check('刷新后副本的改动仍在、原件未受影响', rCopy.shapes[0].name === '副本改过的形状' && rProj.shapes[0].name === '嵌套形')
  check('刷新后副本 holes 仍指向自己的轮廓', rCopy.shapes[0].contours[0].holes[0] === rCopy.shapes[0].contours[1].id)

  // ============ 场景 4：loadState 幂等（重复调用不覆盖内存改动） ============
  console.log('场景 4：loadState 幂等')
  const before = state.projects.length
  getProject(proj.id)!.name = '尚未落盘的改名'
  loadState() // 应直接返回，不能用磁盘旧数据覆盖内存
  check('重复 loadState 不覆盖内存改动', getProject(proj.id)!.name === '尚未落盘的改名' && state.projects.length === before)
  saveNow()

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
