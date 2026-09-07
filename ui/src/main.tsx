import '@arco-design/web-react/dist/css/arco.css'
import ReactDOM from 'react-dom/client'
import App from './App'
import './global.css'

// arco 中文语言包走具名导出（避免拉全量 locale 目录）
import { ConfigProvider } from '@arco-design/web-react'
import zhCN from '@arco-design/web-react/es/locale/zh-CN'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ConfigProvider locale={zhCN}>
    <App />
  </ConfigProvider>,
)
