import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 面板构建产物直接被 dsh host 伺服（/learnhub/* → web/dist/*）。
// base './'：产物挂在 /learnhub 前缀下，资源引用必须是相对路径。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
})
