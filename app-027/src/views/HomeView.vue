<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { PATTERN_CATEGORIES, PATTERN_LIBRARY, fetchPatternText, type PatternEntry } from '@/data/patterns'
import { store, state } from '@/logic/store'
import type { Shape } from '@/logic/types'
import { DEFAULT_CUT_SETTINGS } from '@/logic/types'

const router = useRouter()
const category = ref<(typeof PATTERN_CATEGORIES)[number]>('全部')
const busy = ref('')
const notice = ref('')
const error = ref('')
const importedSummary = ref<Array<{ name: string; kept: number; notClosed: number; selfIntersect: number; duplicates: number }>>([])

const filtered = computed(() =>
  category.value === '全部' ? PATTERN_LIBRARY : PATTERN_LIBRARY.filter((p) => p.category === category.value),
)

const projects = computed(() => state.projects.slice().sort((a, b) => b.updatedAt - a.updatedAt))

onMounted(() => {
  store.loadState()
})

function base(file: string): string {
  return `${import.meta.env.BASE_URL}patterns/${file}`
}

async function newFromPattern(p: PatternEntry): Promise<void> {
  busy.value = p.slug
  error.value = ''
  try {
    const text = await fetchPatternText(p.file)
    const { result, shape } = store.importSvgToShapes(text, p.name, DEFAULT_CUT_SETTINGS)
    const project = store.createProjectFromShapes(p.name, [shape])
    project.settings.toleranceMm = DEFAULT_CUT_SETTINGS.toleranceMm
    store.recomputeProject(project, true)
    importedSummary.value = [
      {
        name: p.name,
        kept: result.contours.length,
        notClosed: result.cleanup.notClosed,
        selfIntersect: result.cleanup.selfIntersect,
        duplicates: result.cleanup.duplicates,
      },
    ]
    await router.push(`/design/${project.id}`)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

async function onFiles(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return
  error.value = ''
  notice.value = ''
  const shapes: Shape[] = []
  const summary: typeof importedSummary.value = []
  for (const file of Array.from(files)) {
    try {
      const text = await file.text()
      const name = file.name.replace(/\.svg$/i, '')
      const { result, shape } = store.importSvgToShapes(text, name, DEFAULT_CUT_SETTINGS)
      shapes.push(shape)
      summary.push({
        name: file.name,
        kept: result.contours.length,
        notClosed: result.cleanup.notClosed,
        selfIntersect: result.cleanup.selfIntersect,
        duplicates: result.cleanup.duplicates,
      })
    } catch (e) {
      error.value = `${file.name}：${(e as Error).message}`
    }
  }
  if (shapes.length === 0) return
  const projectName = shapes.length === 1 ? shapes[0].name : `导入 ${shapes.length} 个纹样`
  const project = store.createProjectFromShapes(projectName, shapes)
  importedSummary.value = summary
  notice.value = `已导入 ${shapes.length} 个文件，共 ${summary.reduce((a, s) => a + s.kept, 0)} 条轮廓`
  await router.push(`/design/${project.id}`)
}

function newBlank(): void {
  const project = store.createBlankProject('未命名纹样')
  void router.push(`/design/${project.id}`)
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  void onFiles(e.dataTransfer?.files ?? null)
}

function remove(id: string, name: string): void {
  if (confirm(`删除项目「${name}」？该操作不可撤销。`)) store.deleteProject(id)
  if (state.lastError) error.value = state.lastError
}

function copy(id: string): void {
  const p = store.duplicateProject(id)
  if (p) void router.push(`/design/${id}`)
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shapeStats(p: { shapes: Shape[] }): string {
  const contours = p.shapes.reduce((a, s) => a + s.contours.length, 0)
  return `${p.shapes.length} 形状 / ${contours} 轮廓`
}
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <div class="hero">
        <div>
          <h1>剪纸刻绘刀路生成</h1>
          <p class="hero-sub">
            把剪纸纹样变成刻字机/刻绘机能直接切的刀路：轮廓闭合检查 → 自动留「连刀点」让小纸片不掉 → 按先内后外的顺序切割 → 导出 PLT 直接上机。
          </p>
          <div class="flow">
            <span class="tag">1 导入纹样</span>
            <span class="arrow">→</span>
            <span class="tag">2 清理路径</span>
            <span class="arrow">→</span>
            <span class="tag">3 生成连刀点</span>
            <span class="arrow">→</span>
            <span class="tag">4 排序与跳刀</span>
            <span class="arrow">→</span>
            <span class="tag accent">5 导出 PLT</span>
          </div>
        </div>
        <div class="hero-actions">
          <button class="primary" @click="newBlank">＋ 新建空白纹样</button>
          <label class="btn file-btn">
            导入 SVG
            <input type="file" accept=".svg,image/svg+xml" multiple @change="onFiles(($event.target as HTMLInputElement).files)" />
          </label>
          <span class="hint">支持 path / line / polygon / circle / rect / ellipse 与 transform 变换矩阵</span>
        </div>
      </div>

      <div v-if="error" class="banner err">{{ error }}</div>
      <div v-if="notice" class="banner ok">{{ notice }}</div>

      <div v-if="importedSummary.length > 0" class="card report">
        <div class="section-title">最近一次导入的清理结果</div>
        <table class="grid">
          <thead>
            <tr>
              <th>文件</th>
              <th>保留轮廓</th>
              <th>未闭合</th>
              <th>自交</th>
              <th>重复（已合并）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in importedSummary" :key="s.name">
              <td>{{ s.name }}</td>
              <td class="num">{{ s.kept }}</td>
              <td class="num" :class="{ warnCell: s.notClosed > 0 }">{{ s.notClosed }}</td>
              <td class="num" :class="{ warnCell: s.selfIntersect > 0 }">{{ s.selfIntersect }}</td>
              <td class="num" :class="{ warnCell: s.duplicates > 0 }">{{ s.duplicates }}</td>
            </tr>
          </tbody>
        </table>
        <div class="hint">详细问题清单可在编辑页查看，并可点选定位到画布。</div>
      </div>

      <div
        class="dropzone"
        @dragover.prevent
        @drop="onDrop"
      >
        把 SVG 文件拖到这里导入（也可点上面的「导入 SVG」）
      </div>

      <h2 class="sec">内置纹样库（本地打包，离线可用）</h2>
      <div class="cats">
        <button
          v-for="c in PATTERN_CATEGORIES"
          :key="c"
          class="tiny"
          :class="{ active: category === c }"
          @click="category = c"
        >
          {{ c }}
        </button>
      </div>
      <div class="card-grid">
        <div v-for="p in filtered" :key="p.slug" class="pattern-card" @click="newFromPattern(p)">
          <div class="thumb">
            <img :src="base(p.file)" :alt="p.name" />
          </div>
          <div class="meta">
            <div class="n">{{ p.name }}</div>
            <div class="d">{{ p.category }}｜{{ p.desc }}</div>
            <div class="traits">
              <span v-for="t in p.traits" :key="t" class="tag">{{ t }}</span>
            </div>
          </div>
          <div class="card-foot">
            <span v-if="busy === p.slug" class="hint">解析中…</span>
            <span v-else class="hint">点此新建项目</span>
          </div>
        </div>
      </div>

      <h2 class="sec">我的项目</h2>
      <div v-if="projects.length === 0" class="empty">还没有项目，点上面的纹样卡片或「新建空白纹样」开始。</div>
      <table v-else class="grid">
        <thead>
          <tr>
            <th>名称</th>
            <th>内容</th>
            <th>材料</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in projects" :key="p.id">
            <td>
              <a href="#" @click.prevent="router.push(`/design/${p.id}`)">{{ p.name }}</a>
            </td>
            <td class="mono">{{ shapeStats(p) }}</td>
            <td>{{ store.materialOf(p)?.name ?? '-' }}</td>
            <td class="mono">{{ fmtTime(p.updatedAt) }}</td>
            <td>
              <div class="btn-row">
                <button class="tiny" @click="router.push(`/design/${p.id}`)">编辑</button>
                <button class="tiny" @click="router.push(`/layout/${p.id}`)">排版</button>
                <button class="tiny" @click="router.push(`/export/${p.id}`)">导出</button>
                <button class="tiny" @click="copy(p.id)">复制</button>
                <button class="tiny danger" @click="remove(p.id, p.name)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  justify-content: space-between;
  background: linear-gradient(120deg, #1c2530, #191f27);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 14px;
}

.hero-sub {
  color: var(--text-dim);
  max-width: 720px;
  font-size: 12.5px;
}

.flow {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.arrow {
  color: var(--text-mute);
}

.hero-actions {
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: flex-start;
  flex: 0 0 auto;
}

.hero-actions .hint {
  max-width: 220px;
}

.file-btn {
  position: relative;
  overflow: hidden;
}

.file-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.banner {
  padding: 7px 10px;
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 12.5px;
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
}

.banner.ok {
  background: rgba(71, 192, 122, 0.12);
  border: 1px solid rgba(71, 192, 122, 0.35);
  color: #9fe0b8;
}

.dropzone {
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 14px;
  text-align: center;
  color: var(--text-mute);
  font-size: 12px;
  margin-bottom: 14px;
}

.dropzone:hover {
  border-color: var(--accent);
  color: var(--accent-2);
}

.sec {
  margin: 18px 0 8px;
}

.cats {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.cats button.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #1a1206;
  font-weight: 600;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.traits {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 5px;
}

.card-foot {
  border-top: 1px solid var(--line-soft);
  padding: 4px 9px;
  background: var(--panel-2);
}

.report {
  margin-bottom: 12px;
}

.warnCell {
  color: var(--warn);
}
</style>