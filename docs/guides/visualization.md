# AFL 工作流可视化

长工作流可以先转换成一份静态交互图，再检查模型调用、依赖、分支、并发和 Node 组合关系：

```bash
afl visualize workflow.afl
```

默认输出与源文件同目录下的 `workflow.graph.html`。它是没有外部依赖的单文件，可以直接用浏览器打开。也可以指定入口和输出位置：

```bash
afl visualize workflow.afl --entry main --output artifacts/workflow.html
```

## 图节点如何划分

- 每次 `agent.do`、`fork`、`freedom.route` 或 `freedom.flow` 的 Agent activation 单独显示为一个模型调用节点。
- 带条件的 `jump` 显示为分支节点，保留 `true`、`false` 和循环方向；有序跳转表也只显示为一个分支节点，各 case 与 `default` 标在对应路径上。
- 普通计算、Prompt、Agent 配置、Memory、capability、dispatch、sync、输入、返回和失败不占用图节点，而是压缩到模型或分支之间的计算路径上。
- 本地 `call`、本地 dispatch target 以及 Freedom 候选 Node 默认原地展开，并用 scope 边框保留调用边界。递归调用或超过展开深度时在计算路径中保留调用引用，避免生成无限图。

计算路径来自静态数据依赖和控制流，而不是源文件行序。路径标签概括其中折叠的运算与控制行为；点击连线可以在右侧查看完整 IR。入口或尾部没有模型/分支节点时，布局使用轻量的 `START`/`END` 端点保留进入或退出路径；这些端点不计入语义节点。Freedom 候选使用虚线和 `dynamic` 标记，因为它们是允许执行的范围，不代表一次具体运行中全部被选择。

图布局使用 ELK Layered。生成阶段会把展开的 Node scope 转成 compound graph，通过交叉最小化重新排列同层节点，并为普通依赖、分支和循环分配固定方向端口。连线使用 ELK 返回的正交路径；循环优先从节点侧面绕回，减少穿过主流程的长边。复杂图不能保证完全没有交叉，但布局不依赖源码顺序的简单排序。

## 查看与筛选

生成的页面支持拖动画布、滚轮缩放、适应视图、文本搜索、模型/分支节点聚焦、scope 聚焦和动态候选开关。搜索同时覆盖节点和计算路径。为避免大型候选集压缩主流程，页面首屏隐藏 Freedom 动态候选；打开开关后才显示这些可选 scope。选中节点会显示来源 Node、block 和源码，选中连线会显示被折叠的完整运算。

大型工作流可以限制 Node 展开深度，或完全省略 Freedom 候选：

```bash
afl visualize workflow.afl --max-depth 4
afl visualize workflow.afl --hide-dynamic
```

## 库接口

需要在编辑器或其他界面中渲染时，可以直接使用结构化图模型：

```ts
import {
  buildAflVisualGraph,
  parseAfl,
  renderAflVisualGraphHtml,
} from "@afl-lang/core";

const module = parseAfl(source, "workflow.afl");
const graph = buildAflVisualGraph(module, source, { entry: "main" });
const html = await renderAflVisualGraphHtml(graph);
```

`renderAflVisualGraphHtml` 会异步计算主流程和完整候选两套 ELK 布局，但布局结果而非 ELK 运行时会写入 HTML，因此输出仍是可直接打开的单文件。需要复用坐标或接入其他渲染器时，可以单独调用 `layoutAflVisualGraph(graph)`。

`buildAflVisualGraph` 假定传入的 module 已通过验证；参考 CLI 会在生成前自动运行完整静态验证。可视化是静态 IR 视图，不代替 trace，也不表示某次运行实际采用的动态路由、模型内部 tool call 或执行时长。
