// ui/ ESLint 配置（#183 / ADR-0051 第二层首例、ADR-0052 lint 安置）：只做 react-hooks
// 静态检查——rules-of-hooks（error）+ exhaustive-deps（warn）。不做任何风格 lint。
// TS 语法需要 TS 解析器（@typescript-eslint/parser 仅作 parser，不用其规则集）。
import parser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
