<script setup lang="ts">
import { computed, ref } from 'vue'
import { FAQ, FORMAT_DOCS } from '@/data/help'
import { runSelfTest, type SelfTestReport } from '@/logic/selftest'
import { defaultMaterials } from '@/data/materials'
import { DEFAULT_CUT_SETTINGS } from '@/logic/types'

const running = ref(false)
const report = ref<SelfTestReport | null>(null)
const error = ref('')
const showAll = ref(false)

const passCount = computed(() => report.value?.checks.filter((c) => c.pass).length ?? 0)
const failCount = computed(() => report.value?.checks.filter((c) => !c.pass).length ?? 0)
const visibleChecks = computed(() => {
  if (!report.value) return []
  return showAll.value ? report.value.checks : report.value.checks.filter((c) => !c.pass)
})

async function run(): Promise<void> {
  running.value = true
  error.value = ''
  report.value = null
  try {
    report.value = await runSelfTest(DEFAULT_CUT_SETTINGS, defaultMaterials()[0])
  } catch (e) {
    error.value = `自检执行失败：${(e as Error).message}`
  } finally {
    running.value = false
  }
}

const steps = [
  { t: '装刀与调刀压', d: '刀尖伸出量按纸张厚度调整（一般 0.1~0.3mm）。先在边角料上试切：切不透就加刀压或增加遍数，切穿垫板就减刀压。' },
  { t: '固定纸张', d: '用刻字机自带的压纸轮或美纹纸固定，纸面不能有起伏，否则会出现局部切不透。' },
  { t: '导入刀路文件', d: 'PLT 直接拖进机器配套软件或直接发送到刻字机；G-code 用桌面机的控制软件打开。' },
  { t: '确认原点与方向', d: 'PLT 原点在左下。发送前先空走一遍（抬刀）确认图形在纸幅内，尤其是 y 方向。' },
  { t: '检查连刀点', d: '切完先不要揭纸。用手轻推小纸片，能挂住不掉即为合格；若掉落，把连刀点宽度加大 0.1~0.2mm 重新导出。' },
  { t: '揭纸与整理', d: '从边角慢慢揭起，镂空件用小镊子辅助。宣纸类建议先覆一层保护膜再揭。' },
]

const faqOpen = ref<number | null>(0)
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <h1>上机指南</h1>
      <p class="hint">从刀路生成到上机切割的完整流程、导出格式说明与常见问题。</p>

      <h2 class="sec">导出格式说明</h2>
      <div class="card-grid">
        <div v-for="f in FORMAT_DOCS" :key="f.name" class="card">
          <h3>{{ f.name }}</h3>
          <p class="hint">{{ f.detail }}</p>
        </div>
      </div>

      <h2 class="sec">上机步骤</h2>
      <div class="card">
        <ol class="steps">
          <li v-for="(s, i) in steps" :key="s.t">
            <span class="seq">{{ i + 1 }}</span>
            <div>
              <strong>{{ s.t }}</strong>
              <div class="hint">{{ s.d }}</div>
            </div>
          </li>
        </ol>
      </div>

      <h2 class="sec">常见问题</h2>
      <div class="faq">
        <div v-for="(f, i) in FAQ" :key="f.q" class="faq-item">
          <button class="faq-q" @click="faqOpen = faqOpen === i ? null : i">
            <span class="mark">{{ faqOpen === i ? '−' : '+' }}</span>
            {{ f.q }}
          </button>
          <div v-if="faqOpen === i" class="faq-a">{{ f.a }}</div>
        </div>
      </div>

      <h2 class="sec">验收自检（第 10 节标准）</h2>
      <div class="card">
        <p class="hint">
          一键跑完第 10 节全部验收用例：导入 10 个真实窗花 SVG、连刀点宽度与几何偏差、碎片必连刀、长度规则数量、嵌套 3 层、先内后外、2-opt 跳刀缩短
          ≥15%、PLT 坐标范围与左下原点、G-code 单位与进给、A4 校验尺 1:1、5000 点性能、刀补自交裁剪。
        </p>
        <div class="btn-row" style="margin: 8px 0">
          <button class="primary" :disabled="running" @click="run">{{ running ? '自检中…' : '运行验收自检' }}</button>
          <label v-if="report" class="check"><input type="checkbox" v-model="showAll" /> 显示全部用例（默认只列失败项）</label>
        </div>

        <div v-if="error" class="banner err">{{ error }}</div>

        <template v-if="report">
          <div class="stat-grid" style="margin-bottom: 10px">
            <div class="stat">
              <div class="k">通过</div>
              <div class="v" style="color: var(--ok)">{{ passCount }}<small>/{{ report.checks.length }}</small></div>
            </div>
            <div class="stat"><div class="k">失败</div><div class="v" :style="{ color: failCount ? 'var(--err)' : '' }">{{ failCount }}</div></div>
            <div class="stat"><div class="k">自检总耗时</div><div class="v">{{ report.totalMs.toFixed(0) }}<small>ms</small></div></div>
          </div>

          <div v-if="failCount === 0" class="banner ok">全部 {{ report.checks.length }} 条用例通过</div>

          <div class="check-list">
            <div v-for="c in visibleChecks" :key="c.id" class="check-row" :class="c.pass ? 'pass' : 'fail'">
              <span class="icon">{{ c.pass ? '✓' : '✕' }}</span>
              <div>
                <div>{{ c.title }}</div>
                <div class="detail">{{ c.detail }}</div>
              </div>
            </div>
            <div v-if="visibleChecks.length === 0 && failCount === 0" class="empty">没有失败用例</div>
          </div>

          <div class="section">
            <div class="section-title">10 个纹样的清理与连刀结果</div>
            <table class="grid">
              <thead>
                <tr>
                  <th>纹样</th>
                  <th>轮廓</th>
                  <th>未闭合</th>
                  <th>自交</th>
                  <th>重复</th>
                  <th>层深</th>
                  <th>碎片</th>
                  <th>连刀点</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in report.summaries" :key="s.file">
                  <td>{{ s.name }}</td>
                  <td class="num">{{ s.kept }}</td>
                  <td class="num" :class="{ warnCell: s.notClosed > 0 }">{{ s.notClosed }}</td>
                  <td class="num" :class="{ warnCell: s.selfIntersect > 0 }">{{ s.selfIntersect }}</td>
                  <td class="num" :class="{ warnCell: s.duplicates > 0 }">{{ s.duplicates }}</td>
                  <td class="num">{{ s.maxDepth }}</td>
                  <td class="num">{{ s.fragments }}</td>
                  <td class="num">{{ s.bridges }}</td>
                  <td class="num">{{ s.ms.toFixed(1) }}ms</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sec {
  margin: 18px 0 8px;
}

.steps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.steps li {
  display: flex;
  gap: 9px;
  align-items: flex-start;
}

.faq {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.faq-item {
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: var(--panel);
}

.faq-q {
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 0;
  background: var(--panel-2);
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text);
}

.faq-q:hover {
  color: var(--accent-2);
  background: var(--panel-3);
}

.faq-q .mark {
  display: inline-block;
  width: 14px;
  color: var(--accent);
  font-weight: 700;
}

.faq-a {
  padding: 9px 12px 10px 33px;
  font-size: 12.5px;
  color: var(--text-dim);
  line-height: 1.7;
  border-top: 1px solid var(--line-soft);
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

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
}

.check-list {
  display: flex;
  flex-direction: column;
}

.warnCell {
  color: var(--warn);
}
</style>