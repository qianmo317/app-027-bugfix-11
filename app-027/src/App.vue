<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { store } from '@/logic/store'

const route = useRoute()

const project = computed(() => {
  const id = route.params.id
  if (typeof id !== 'string') return null
  return store.getProject(id) ?? null
})

const contextLabel = computed(() => {
  if (!project.value) return ''
  return project.value.name
})
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <RouterLink class="brand" to="/">
        <span class="brand-mark"></span>
        <span>剪纸刻绘刀路生成</span>
        <span class="brand-sub">Paper-cut Plotter Studio</span>
      </RouterLink>

      <nav class="nav">
        <RouterLink to="/">纹样库</RouterLink>
        <RouterLink v-if="project" :to="`/design/${project.id}`">编辑</RouterLink>
        <RouterLink v-if="project" :to="`/layout/${project.id}`">排版</RouterLink>
        <RouterLink v-if="project" :to="`/export/${project.id}`">导出</RouterLink>
        <RouterLink to="/materials">材料预设</RouterLink>
        <RouterLink to="/help">上机指南</RouterLink>
      </nav>

      <div class="header-right">
        <span v-if="contextLabel" class="tag accent">{{ contextLabel }}</span>
        <span class="tag ok">离线可用</span>
      </div>
    </header>

    <RouterView />
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 0;
}
</style>