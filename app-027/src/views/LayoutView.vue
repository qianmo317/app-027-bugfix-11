<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PreviewCanvas from '@/components/PreviewCanvas.vue'
import { store } from '@/logic/store'
import { simulationPath, type JobStep } from '@/logic/job'
import type { ComputedShape } from '@/logic/pipeline'
import type { Pt } from '@/logic/types'
import { boundsOf, mergeBounds } from '@/logic/geometry'
import { computePlacement, SHEET_MARGIN_MM } from '@/logic/exporters'

const route = useRoute()
const router = useRouter()
const canvas = ref<InstanceType<typeof PreviewCanvas> | null>(null)

const projectId = computed(() => String(route.params.id))
const project = computed(() => store.getProject(projectId.value) ?? null)

const jobData = computed(() => (project.value ? store.jobOf(project.value) : null))
const job = computed(() => jobData.value?.job ?? null)
const material = computed(() => (project.value ? store.materialOf(project.value) : null))

const shapesForCanvas = computed(() => {
  const p = project.value
  if (!p) return []
  const d = jobData.value
  if (d?.isBatch && d.shape) return [d.shape]
  return p.shapes
})

const computedMap = computed(() => {
  const m = new Map<string, ComputedShape>()
  const d = jobData.value
  if (d) for (const [k, v] of d.computed) m.set(k, v)
  return m
})

const placement = computed(() => {
  const p = project.value
  if (!p || !job.value) return null
  return computePlacement(job.value.steps, p.sheet, p.export.scale)
})

/** 纸幅是否放得下 */
const fitInfo = computed(() => {
  const p = project.value
  if (!p || !job.value) return null
  const pts: Pt[] = []
  for (const st of job.value.steps) pts.push(...st.points)
  if (pts.length === 0) return null
  const b = boundsOf(pts)
  const w = (b.maxX - b.minX) * p.export.scale
  const h = (b.maxY - b.minY) * p.export.scale
  const availW = p.sheet.widthMm - SHEET_MARGIN_MM * 2
  const availH = p.sheet.heightMm - SHEET_MARGIN_MM * 2
  const fits = w <= availW + 0.01 && h <= availH + 0.01
  return { w, h, availW, availH, fits, suggestScale: fits ? p.export.scale : Math.min(availW / (b.maxX - b.minX || 1), availH / (b.maxY - b.minY || 1)) }
})

function autoFit(): void {
  const p = project.value
  const f = fitInfo.value
  if (!p || !f) return
  store.updateExport(p, { scale: Math.max(0.05, Math.round(f.suggestScale * 1000) / 1000) })
}

// ---------------- 顺序表 ----------------
const steps = computed<JobStep[]>(() => job.value?.steps ?? [])
const selectedSeq = ref<number | null>(null)

function locateStep(st: JobStep): void {
  selectedSeq.value = st.seq
  canvas.value?.focusContour(st.contourId)
}

const layers = computed(() => {
  const p = project.value
  if (!p) return []
  const set = new Map<number, { count: number; contours: number; length: number }>()
  for (const s of p.shapes) {
    const cur = set.get(s.layer) ?? { count: 0, contours: 0, length: 0 }
    cur.count += 1
    cur.contours += s.contours.length
    cur.length += store.computedOf(s.id)?.stats.cutLengthMm ?? 0
    set.set(s.layer, cur)
  }
  return Array.from(set.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([layer, v]) => ({ layer, ...v }))
})

const layerName = (layer: number): string => project.value?.layerNames?.[layer] ?? `图层 ${layer + 1}`

function renameLayer(layer: number, name: string): void {
  const p = project.value
  if (!p) return
  p.layerNames[layer] = name
  store.touch(p)
}

function moveLayer(layer: number, dir: -1 | 1): void {
  const p = project.value
  if (!p) return
  const target = layer + dir
  if (target < 0 || !p.shapes.some((s) => s.layer === target)) return
  for (const s of p.shapes) {
    if (s.layer === layer) s.layer = -999
    else if (s.layer === target) s.layer = layer
  }
  for (const s of p.shapes) if (s.layer === -999) s.layer = target
  store.recomputeProject(p, true)
  store.touch(p)
}

function toggleLayerShape(s: { id: string; layer: number }, layer: number): void {
  const p = project.value
  if (!p) return
  s.layer = layer
  store.recomputeProject(p, true)
  store.touch(p)
}

// ---------------- 仿真 ----------------
const sim = ref({ playing: false, index: 0, speed: 120 })
let raf = 0
let last = 0

const simPoints = computed(() => simulationPath(steps.value))
const simPts = computed(() => {
  if (!sim.value.playing && sim.value.index === 0) return null
  return simPoints.value.slice(0, Math.max(1, sim.value.index)).map((p) => p.p)
})

function tick(t: number): void {
  if (!sim.value.playing) return
  const dt = last === 0 ? 16 : t - last
  last = t
  const add = (sim.value.speed * dt) / 1000
  const total = simPoints.value.length
  sim.value.index = Math.min(total, sim.value.index + add)
  if (sim.value.index >= total) {
    sim.value.playing = false
    sim.value.index = total
    return
  }
  raf = requestAnimationFrame(tick)
}

function toggleSim(): void {
  if (simPoints.value.length === 0) return
  if (sim.value.playing) {
    sim.value.playing = false
    cancelAnimationFrame(raf)
    return
  }
  if (sim.value.index >= simPoints.value.length) sim.value.index = 0
  sim.value.playing = true
  last = 0
  raf = requestAnimationFrame(tick)
}

function resetSim(): void {
  sim.value.playing = false
  cancelAnimationFrame(raf)
  sim.value.index = 0
}

onUnmounted(() => cancelAnimationFrame(raf))

watch(
  () => steps.value.length,
  () => resetSim(),
)

const currentStep = computed(() => {
  if (sim.value.index <= 0) return null
  const p = simPoints.value[Math.min(simPoints.value.length - 1, Math.max(0, Math.floor(sim.value.index) - 1))]
  return p ? steps.value[p.stepIndex] ?? null : null
})

// ---------------- 批量排版 ----------------
const batch = computed(() => project.value?.batch)

function patchBatch(mut: (b: NonNullable<typeof batch.value>) => void): void {
  const p = project.value
  if (!p) return
  if (!p.batch) p.batch = { enabled: false, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' }
  mut(p.batch)
  if (!p.batchShapeId && p.shapes.length) p.batchShapeId = p.shapes[0].id
  store.updateBatch(p, {})
}

function setBatchShape(id: string): void {
  const p = project.value
  if (!p) return
  p.batchShapeId = id
  store.updateBatch(p, {})
}

const batchInfo = computed(() => {
  const p = project.value
  const b0 = batch.value
  if (!p || !b0?.enabled) return null
  const tiles = b0.rows * b0.cols
  const src = p.shapes.find((s) => s.id === p.batchShapeId) ?? p.shapes[0]
  if (!src) return null
  const pts = src.contours.flatMap((c) => c.points)
  if (pts.length === 0) return null
  const b = boundsOf(pts)
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  const totalW = b0.cols * w + (b0.cols - 1) * b0.gapXMm
  const totalH = b0.rows * h + (b0.rows - 1) * b0.gapYMm
  const sharedEdges = b0.sharedEdge && b0.gapXMm === 0 && b0.gapYMm === 0
  return {
    tiles,
    w: totalW,
    h: totalH,
    fits: totalW <= p.sheet.widthMm - SHEET_MARGIN_MM * 2 + 0.01 && totalH <= p.sheet.heightMm - SHEET_MARGIN_MM * 2 + 0.01,
    sharedEdges,
  }
})

// ---------------- 打印材料卡 ----------------
const cardRef = ref<HTMLDivElement | null>(null)

function printCard(): void {
  window.print()
}

const printTime = computed(() => {
  const p = project.value
  if (!p || !material.value) return '-'
  const speed = Math.max(1, material.value.speedMmS)
  const total = (job.value?.cutLengthMm ?? 0) * material.value.passes
  return `${(total / speed).toFixed(0)} s`
})

const boundsInfo = computed(() => {
  const pts: Pt[] = []
  for (const st of steps.value) pts.push(...st.points)
  if (pts.length === 0) return null
  const b = mergeBounds([boundsOf(pts)])
  return { w: b.maxX - b.minX, h: b.maxY - b.minY }
})
</script>

<template>
  <div v-if="!project" class="splash">项目不存在，请返回纹样库 <RouterLink to="/">返回</RouterLink></div>
  <div v-else class="workbench-layout">
    <div class="panel canvas-panel">
      <div class="panel-head">
        排版预览（刀路 · 跳刀 · 顺序）
        <span class="spacer"></span>
        <span class="tag accent" v-if="jobData?.isBatch">批量排版 {{ batch?.rows }}×{{ batch?.cols }}</span>
        <span class="tag mono">{{ steps.length }} 段刀路</span>
      </div>
      <PreviewCanvas
        ref="canvas"
        :shapes="shapesForCanvas"
        :computed="computedMap"
        mode="toolpath"
        tool="select"
        :sheet="project.sheet"
        :show-numbers="true"
        :show-travel="true"
        :placement="placement"
        :sim-path="simPts"
        :sim-index="simPts ? simPts.length - 1 : -1"
        :status-text="currentStep ? `正在切 #${currentStep.seq}` : ''"
        @select-contour="selectedSeq = null"
      />
      <div class="panel-foot">
        <div class="sim-bar">
          <button class="tiny primary" @click="toggleSim">{{ sim.playing ? '暂停' : '刀路仿真' }}</button>
          <button class="tiny" @click="resetSim">重置</button>
          <span class="mono progress">{{ Math.round(sim.index) }} / {{ simPoints.length }}</span>
          <input type="range" min="10" max="600" step="10" v-model.number="sim.speed" title="仿真速度（点/秒）" />
          <span class="hint">{{ sim.speed }} 点/秒</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">切割顺序 / 跳刀 / 材料</div>
      <div class="panel-body">
        <div class="stat-grid">
          <div class="stat"><div class="k">刀路总长</div><div class="v">{{ (job?.cutLengthMm ?? 0).toFixed(1) }}<small>mm</small></div></div>
          <div class="stat"><div class="k">跳刀（优化后）</div><div class="v">{{ (job?.travelMm ?? 0).toFixed(1) }}<small>mm</small></div></div>
          <div class="stat"><div class="k">跳刀（朴素顺序）</div><div class="v">{{ (job?.naiveTravelMm ?? 0).toFixed(1) }}<small>mm</small></div></div>
          <div class="stat">
            <div class="k">缩短比例</div>
            <div class="v" :style="{ color: (job?.improvementPct ?? 0) >= 15 ? 'var(--ok)' : '' }">{{ (job?.improvementPct ?? 0).toFixed(1) }}<small>%</small></div>
          </div>
          <div class="stat"><div class="k">纹样尺寸</div><div class="v">{{ boundsInfo ? boundsInfo.w.toFixed(0) + '×' + boundsInfo.h.toFixed(0) : '-' }}<small>mm</small></div></div>
          <div class="stat"><div class="k">预计用时</div><div class="v">{{ printTime }}</div></div>
        </div>

        <div v-if="fitInfo && !fitInfo.fits" class="banner warn">
          纹样 {{ fitInfo.w.toFixed(0) }}×{{ fitInfo.h.toFixed(0) }}mm 超出纸幅可用范围
          {{ fitInfo.availW.toFixed(0) }}×{{ fitInfo.availH.toFixed(0) }}mm，可直接自动缩放排版。
          <button class="tiny" @click="autoFit">自动缩放至适配（{{ (fitInfo.suggestScale * 100).toFixed(0) }}%）</button>
        </div>

        <div class="section">
          <div class="section-title">
            切割顺序（后序遍历 · 先内后外）
            <span class="tag">层深</span>
          </div>
          <div class="order-list">
            <div
              v-for="st in steps"
              :key="st.seq"
              class="list-item"
              :class="{ active: selectedSeq === st.seq }"
              @click="locateStep(st)"
            >
              <span class="seq">{{ st.seq }}</span>
              <span class="grow">
                <span class="mono">{{ st.shapeName }}</span>
                <span class="tag" style="margin-left: 5px">L{{ st.level }}{{ st.layer > 0 ? ` / 图层${st.layer + 1}` : '' }}</span>
                <span v-if="st.runCount > 1" class="tag">连刀段 {{ st.runIndex + 1 }}/{{ st.runCount }}</span>
              </span>
              <span class="mono dim">{{ st.lengthMm.toFixed(1) }}mm</span>
              <span class="mono dim">↗{{ st.travelFromPrevMm.toFixed(1) }}</span>
            </div>
          </div>
          <div class="hint">数字为刀路顺序气泡；↗ 为从上一段末尾跳过来的距离（mm）。跳刀用虚线画出，越小越省时间。</div>
        </div>

        <div class="section">
          <div class="section-title">图层与多色纸</div>
          <table class="grid">
            <thead>
              <tr><th>图层</th><th>形状</th><th>轮廓</th><th>刀路</th><th>顺序</th></tr>
            </thead>
            <tbody>
              <tr v-for="l in layers" :key="l.layer">
                <td>
                  <input type="text" :value="layerName(l.layer)" @change="renameLayer(l.layer, ($event.target as HTMLInputElement).value)" />
                </td>
                <td class="num">{{ l.count }}</td>
                <td class="num">{{ l.contours }}</td>
                <td class="num">{{ l.length.toFixed(0) }}mm</td>
                <td>
                  <div class="btn-row">
                    <button class="tiny" @click="moveLayer(l.layer, -1)">↑</button>
                    <button class="tiny" @click="moveLayer(l.layer, 1)">↓</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="hint">多个图层 = 多种颜色的纸，按图层顺序依次切割（同层内仍先内后外）。</div>
          <div class="shape-assign">
            <div v-for="s in project.shapes" :key="s.id" class="assign-row">
              <span class="grow">{{ s.name }}</span>
              <select :value="s.layer" @change="toggleLayerShape(s, Number(($event.target as HTMLSelectElement).value))">
                <option v-for="l in layers" :key="l.layer" :value="l.layer">{{ layerName(l.layer) }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="section" v-if="batch">
          <div class="section-title">批量排版（同一纹样排满一张纸）</div>
          <label class="check">
            <input type="checkbox" :checked="batch.enabled" @change="patchBatch((b) => (b.enabled = ($event.target as HTMLInputElement).checked))" />
            启用批量排版
          </label>
          <div v-if="batch.enabled">
            <div class="field-row">
              <label>排版纹样</label>
              <select :value="project.batchShapeId" @change="setBatchShape(($event.target as HTMLSelectElement).value)">
                <option v-for="s in project.shapes" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </div>
            <div class="field-row">
              <label>行 × 列</label>
              <input type="number" min="1" max="20" :value="batch.rows" @change="patchBatch((b) => (b.rows = Number(($event.target as HTMLInputElement).value)))" />
              <input type="number" min="1" max="20" :value="batch.cols" @change="patchBatch((b) => (b.cols = Number(($event.target as HTMLInputElement).value)))" />
            </div>
            <div class="field-row">
              <label>间距 X / Y</label>
              <input type="number" min="0" step="0.5" :value="batch.gapXMm" @change="patchBatch((b) => (b.gapXMm = Number(($event.target as HTMLInputElement).value)))" />
              <input type="number" min="0" step="0.5" :value="batch.gapYMm" @change="patchBatch((b) => (b.gapYMm = Number(($event.target as HTMLInputElement).value)))" />
            </div>
            <div class="field-row">
              <label>排列方式</label>
              <select :value="batch.mode" @change="patchBatch((b) => (b.mode = ($event.target as HTMLSelectElement).value as never))">
                <option value="repeat">同一方向重复</option>
                <option value="four_way">四方连续（镜像）</option>
              </select>
            </div>
            <label class="check">
              <input type="checkbox" :checked="batch.sharedEdge" @change="patchBatch((b) => (b.sharedEdge = ($event.target as HTMLInputElement).checked))" />
              共边裁切（间距为 0 时相邻件的公共边只切一次）
            </label>
            <div v-if="batchInfo" class="hint">
              共 {{ batchInfo.tiles }} 件｜排版尺寸 {{ batchInfo.w.toFixed(0) }}×{{ batchInfo.h.toFixed(0) }}mm
              <span v-if="batchInfo.sharedEdges" class="tag ok">共边已生效</span>
              <span v-if="!batchInfo.fits" class="tag err">超出纸幅</span>
            </div>
          </div>
        </div>

        <div class="section" v-if="material">
          <div class="section-title">材料参数卡</div>
          <table class="grid">
            <tbody>
              <tr><th>材料预设</th><td>{{ material.name }}</td></tr>
              <tr><th>纸张类型</th><td>{{ material.paper }}</td></tr>
              <tr><th>刀压</th><td class="num">{{ material.force }}</td></tr>
              <tr><th>速度</th><td class="num">{{ material.speedMmS }} mm/s</td></tr>
              <tr><th>重复次数</th><td class="num">{{ material.passes }}</td></tr>
              <tr><th>垫板</th><td>{{ material.backing }}</td></tr>
              <tr><th>刀补偏置</th><td class="num">{{ material.bladeOffsetMm }} mm</td></tr>
              <tr><th>连刀点宽</th><td class="num">{{ project.settings.bridgeWidthMm }} mm</td></tr>
            </tbody>
          </table>
          <div class="btn-row" style="margin-top: 6px">
            <button class="tiny primary" @click="printCard">打印工艺卡</button>
            <button class="tiny" @click="router.push('/materials')">材料库</button>
            <button class="tiny" @click="router.push(`/export/${project.id}`)">导出刀路</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 打印区（1:1 工艺卡） -->
    <div class="print-area" ref="cardRef">
      <div class="sheet">
        <div class="card-sheet">
          <h1>剪纸刻绘 · 材料参数卡</h1>
          <div class="card-sub">Paper-cut Plotter Studio</div>
          <table>
            <tbody>
              <tr><th>项目</th><td>{{ project.name }}</td></tr>
              <tr><th>纹样</th><td>{{ shapesForCanvas.map((s) => s.name).join('、') }}</td></tr>
              <tr><th>材料预设</th><td>{{ material?.name }}</td></tr>
              <tr><th>纸张类型</th><td>{{ material?.paper }}</td></tr>
              <tr><th>刀压 force</th><td>{{ material?.force }}</td></tr>
              <tr><th>速度 speed</th><td>{{ material?.speedMmS }} mm/s</td></tr>
              <tr><th>重复次数 passes</th><td>{{ material?.passes }}</td></tr>
              <tr><th>垫板</th><td>{{ material?.backing }}</td></tr>
              <tr><th>刀补 blade offset</th><td>{{ material?.bladeOffsetMm }} mm</td></tr>
              <tr><th>连刀点宽度</th><td>{{ project.settings.bridgeWidthMm }} mm</td></tr>
              <tr><th>纸幅</th><td>{{ project.sheet.widthMm }}×{{ project.sheet.heightMm }} mm（{{ project.sheet.name }}）</td></tr>
              <tr><th>刀路总长</th><td>{{ (job?.cutLengthMm ?? 0).toFixed(1) }} mm</td></tr>
              <tr><th>跳刀总长</th><td>{{ (job?.travelMm ?? 0).toFixed(1) }} mm（朴素 {{ (job?.naiveTravelMm ?? 0).toFixed(1) }} mm）</td></tr>
              <tr><th>预计用时</th><td>{{ printTime }}</td></tr>
            </tbody>
          </table>
          <div class="card-note">
            提示：先用边角料试切一遍，确认切穿且不伤垫板后再批量上机。宣纸建议“轻压 + 多遍”。
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sim-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sim-bar input[type='range'] {
  width: 120px;
}

.progress {
  font-size: 11px;
  color: var(--text-dim);
  min-width: 84px;
}

.order-list {
  max-height: 260px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dim {
  color: var(--text-mute);
  font-size: 11px;
}

.shape-assign {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.assign-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.assign-row select {
  flex: 0 0 110px;
}

.banner.warn {
  background: rgba(255, 200, 87, 0.1);
  border: 1px solid rgba(255, 200, 87, 0.4);
  color: #ffe0a0;
  padding: 7px 9px;
  border-radius: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  margin: 5px 0;
}

.card-sheet {
  width: 150mm;
  margin: 12mm auto;
  border: 1px solid #000;
  padding: 8mm;
  color: #111;
  background: #fff;
  font-family: sans-serif;
}

.card-sheet h1 {
  font-size: 16pt;
  margin: 0 0 2mm;
}

.card-sub {
  font-size: 9pt;
  color: #444;
  margin-bottom: 5mm;
}

.card-sheet table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10pt;
}

.card-sheet th,
.card-sheet td {
  border: 1px solid #666;
  padding: 1.6mm 2mm;
  text-align: left;
}

.card-sheet th {
  width: 42mm;
  background: #f0f0f0;
  font-weight: 600;
}

.card-note {
  margin-top: 5mm;
  font-size: 9pt;
  color: #333;
}
</style>