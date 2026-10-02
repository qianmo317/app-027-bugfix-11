import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { store } from './logic/store'
import './styles/global.css'

store.initStore()
createApp(App).use(router).mount('#app')