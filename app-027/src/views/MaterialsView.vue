<script setup lang="ts">
import { computed, ref } from 'vue'
import { store, state } from '@/logic/store'
import { PAPER_KINDS, type MaterialPreset } from '@/logic/types'
import { uid } from '@/logic/geometry'

const editing = ref<MaterialPreset | null>(null)
const isNew = ref(false)
const notice = ref('')
const printTarget = ref<MaterialPreset | null>(null)

const materials = computed(() => state.materials)

const usedBy = computed(() => {
  const map = new Map<string, number>()
  for (const p of state.projects) map.set(p.materialId, (map.get(p.materialId) ?? 0) + 1)
  return map
})

function paperNote(paper: string): string {
  return PAPER_KINDS.find((p) => p.paper === paper)?.note ?? ''
}

function paperLabel(paper: string): string {
  return PAPER_KINDS.find((p) => p.paper === paper)?.label ?? paper
}

function startNew(): void {
  isNew.value = true
  notice.value = ''
  editing.value = {
    id: uid('mat'),
    name: '新材料',
    paper: 'cardstock',
    force: 120,
    speedMmS: 40,
    passes: 1,
    bladeOffsetMm: 0.25,
    backing: '蓝色中硬垫板',
  }
}

function startEdit(m: MaterialPreset): void {
  isNew.value = false
  notice.value = ''
  editing.value = { ...m }
}

function onPaperChange(paper: string): void {
  const k = PAPER_KINDS.find((p) => p.paper === paper)
  if (!editing.value) return
  editing.value.paper = paper
  if (k) {
    editing.value.force = k.force
    editing.value.speedMmS = k.speedMmS
    editing.value.passes = k.passes
    editing.value.backing = k.backing
  }
}

function save(): void {
  if (!editing.value) return
  if (!editing.value.name.trim()) {
    notice.value = '预设名称不能为空'
    return
  }
  store.upsertMaterial(editing.value)
  notice.value = `已保存预设「${editing.value.name}」`
  editing.value = null
  isNew.value = false
}

function remove(m: MaterialPreset): void {
  if (materials.value.length <= 1) {
    notice.value = '至少保留一个材料预设'
    return
  }
  if (!confirm(`删除材料预设「${m.name}」？使用该预设的项目会自动切换到第一个预设。`)) return
  store.deleteMaterial(m.id)
  if (editing.value?.id === m.id) editing.value = null
  notice.value = `已删除「${m.name}」`
}

function applyToAll(m: MaterialPreset): void {
  for (const p of state.projects) store.setMaterial(p, m.id)
  notice.value = `已把「${m.name}」应用到全部 ${state.projects.length} 个项目`
}

function print(m: MaterialPreset): void {
  printTarget.value = m
  requestAnimationFrame(() => window.print())
}

const printLines = computed(() => {
  const m = printTarget.value
  if (!m) return []
  const speed = Math.max(1, m.speedMmS)
  return [
    ['材料预设', m.name],
    ['纸张类型', `${paperLabel(m.paper)}（${m.paper}）`],
    ['刀压 force', String(m.force)],
    ['速度 speed', `${m.speedMmS} mm/s`],
    ['重复次数 passes', String(m.passes)],
    ['垫板', m.backing],
    ['刀补 blade offset', `${m.bladeOffsetMm} mm`],
    ['建议连刀点宽', '0.3 ~ 0.8 mm'],
    ['每 100mm 刀路耗时', `${((100 / speed) * m.passes).toFixed(1)} s`],
    ['备注', paperNote(m.paper)],
  ]
})
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <h1>材料预设库</h1>
      <p class="hint">
        每个预设包含纸张类型、刀压、速度、重复次数、垫板与刀补偏置。材料参数卡可 1:1 打印贴在机器旁。
      </p>

      <div v-if="notice" class="banner">{{ notice }}</div>

      <div class="btn-row" style="margin: 10px 0">
        <button class="primary" @click="startNew">＋ 新建材料预设</button>
      </div>

      <div class="card-grid">
        <div v-for="m in materials" :key="m.id" class="card mat-card" :class="{ active: editing?.id === m.id }">
          <div class="mat-head">
            <strong>{{ m.name }}</strong>
            <span v-if="usedBy.get(m.id)" class="tag accent">{{ usedBy.get(m.id) }} 个项目在用</span>
          </div>
          <table class="grid">
            <tbody>
              <tr><th>纸张</th><td>{{ paperLabel(m.paper) }}</td></tr>
              <tr><th>刀压</th><td class="num">{{ m.force }}</td></tr>
              <tr><th>速度</th><td class="num">{{ m.speedMmS }} mm/s</td></tr>
              <tr><th>重复</th><td class="num">{{ m.passes }} 次</td></tr>
              <tr><th>垫板</th><td>{{ m.backing }}</td></tr>
              <tr><th>刀补</th><td class="num">{{ m.bladeOffsetMm }} mm</td></tr>
            </tbody>
          </table>
          <div class="hint">{{ paperNote(m.paper) }}</div>
          <div class="btn-row">
            <button class="tiny" @click="startEdit(m)">编辑</button>
            <button class="tiny" @click="print(m)">打印工艺卡</button>
            <button class="tiny" @click="applyToAll(m)">应用到全部项目</button>
            <button class="tiny danger" @click="remove(m)">删除</button>
          </div>
        </div>
      </div>

      <div v-if="editing" class="card edit-card">
        <h3>{{ isNew ? '新建材料预设' : '编辑材料预设' }}</h3>
        <div class="edit-grid">
          <div class="field">
            <label>预设名称</label>
            <input type="text" v-model="editing.name" />
          </div>
          <div class="field">
            <label>纸张类型</label>
            <select :value="editing.paper" @change="onPaperChange(($event.target as HTMLSelectElement).value)">
              <option v-for="k in PAPER_KINDS" :key="k.paper" :value="k.paper">{{ k.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>刀压 force</label>
            <input type="number" min="1" max="500" v-model.number="editing.force" />
          </div>
          <div class="field">
            <label>速度 speed（mm/s）</label>
            <input type="number" min="1" max="500" v-model.number="editing.speedMmS" />
          </div>
          <div class="field">
            <label>重复次数 passes</label>
            <input type="number" min="1" max="10" v-model.number="editing.passes" />
          </div>
          <div class="field">
            <label>刀补 blade offset（mm）</label>
            <input type="number" min="0" max="2" step="0.05" v-model.number="editing.bladeOffsetMm" />
          </div>
          <div class="field">
            <label>垫板</label>
            <input type="text" v-model="editing.backing" />
          </div>
        </div>
        <div class="hint">{{ paperNote(editing.paper) }}</div>
        <div class="btn-row" style="margin-top: 8px">
          <button class="primary" @click="save">保存</button>
          <button @click="editing = null">取消</button>
        </div>
      </div>
    </div>

    <div class="print-area">
      <div class="sheet">
        <div class="card-sheet">
          <h1>剪纸刻绘 · 材料参数卡</h1>
          <div class="card-sub">Paper-cut Plotter Studio｜1:1 打印（请选择「实际大小 / 100%」）</div>
          <table>
            <tbody>
              <tr v-for="row in printLines" :key="row[0]">
                <th>{{ row[0] }}</th>
                <td>{{ row[1] }}</td>
              </tr>
            </tbody>
          </table>
          <div class="card-note">
            上机顺序：装刀 → 调刀压 → 试切边角料 → 确认切穿不伤垫板 → 正式切割。切不透加刀压或加一遍；切穿垫板则减刀压。
          </div>
          <div class="ruler">
            <div class="ruler-line"></div>
            <div class="ruler-labels">
              <span>0</span><span>50</span><span>100 mm</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.banner {
  background: rgba(71, 192, 122, 0.12);
  border: 1px solid rgba(71, 192, 122, 0.35);
  color: #9fe0b8;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  margin-bottom: 8px;
}

.mat-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mat-card.active {
  border-color: var(--accent);
}

.mat-head {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: space-between;
}

.mat-head strong {
  font-size: 13px;
}

.mat-card table.grid th {
  width: 52px;
  border: 0;
  padding: 1px 0;
}

.mat-card table.grid td {
  border: 0;
  padding: 1px 0;
}

.edit-card {
  margin-top: 14px;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px;
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
  width: 45mm;
  background: #f0f0f0;
}

.card-note {
  margin-top: 5mm;
  font-size: 9pt;
  color: #333;
}

.ruler {
  margin-top: 8mm;
}

.ruler-line {
  width: 100mm;
  height: 0;
  border-top: 0.3mm solid #000;
}

.ruler-labels {
  display: flex;
  justify-content: space-between;
  font-size: 8pt;
  margin-top: 1mm;
  width: 100mm;
}
</style>