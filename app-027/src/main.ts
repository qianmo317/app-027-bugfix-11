import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { loadState } from './logic/store'
import './styles/global.css'

// 启动时先从本机恢复项目库，保证直接刷新编辑 / 排版 / 导出页也能拿到数据
loadState()

createApp(App).use(router).mount('#app')
