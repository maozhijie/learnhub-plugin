/**
 * 客户端 JSX 类型面（类型门 strict 档专用声明，运行时零产物）。
 *
 * 客户端的 JSX 工厂由宿主模块加载器在浏览器运行时注入（无 react 依赖，
 * build.mjs 以 esbuild jsx 自动转换出对注入工厂的调用）——TS 侧只能声明其
 * 固有元素面：原生 DOM 标签全集，属性不清洗（宿主工厂自行消化）。入口
 * index.tsx 单文件，`<LearnhubSection />` 一处组合组件；元素类型放最宽
 * （unknown），属性检查交给宿主工厂的运行时行为。
 */
declare global {
  namespace JSX {
    type Element = unknown
    interface ElementClass {
      $implicit: unknown
    }
    interface ElementChildrenAttribute {
      children: unknown
    }
    interface IntrinsicElements {
      [elem: string]: unknown
    }
  }
}

export {}
