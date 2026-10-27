# 欢迎页资产与动画

SVG 是唯一资产源，不维护中间 JSON。

| 编辑源 | 职责 |
| --- | --- |
| `character.svg` | 基础轮廓、透明度和绘制顺序 |
| `src/gui/frontend/app/welcome/welcome-offer.ts` | 从基础轮廓计算捧起姿态 |
| `reveal.svg` | 入场描绘轨迹、笔宽和时序 |

## 编辑与构建

修改 SVG 或动画函数后，运行下文的定向测试。修改轮廓或动作时，另行检查视觉效果，只提交源文件。

`welcome-illustration.tsx` 通过 `*.svg?welcome` 直接导入两个 SVG。`scripts/welcome/plugin.ts` 在 Vite 开发和生产构建时调用 `scripts/welcome/svg.ts`，将路径和元数据转换为模块，并追踪 SVG 修改。浏览器不解析 XML，构建产物不包含捧起目标路径。插画模块首次加载时计算并保存捧起姿态，后续挂载和动画复用。

## 角色轮廓

`character.svg` 使用 `viewBox="420 24 680 730"`，外层绘制分组为 `fill="currentColor"`。`color` 只用于 SVG 预览，运行时继承界面颜色。

图层按以下顺序绘制。构建时校验顺序，渲染器直接遍历 SVG 提取结果：

```text
hair, face-neck, collar, body,
left-sleeve, right-sleeve, left-hand, right-hand
```

每层直接包含路径，路径显式设置 `fill-opacity`。路径标识用于编辑和错误定位，图层内顺序决定叠放顺序。`hair` 只包含发丝，脸颊与肩颈描线属于 `face-neck`，风吹不能移动这些描线。

角色路径只使用显式绝对 `M`、`L`、`C`、`Z` 指令，每组坐标前都写指令。构建时解析并统一序列化基础路径，运行时通过 `offerPath` 计算目标轮廓。基础姿态与捧起姿态保留相同的路径拓扑，基础坐标保留原始精度，目标坐标保留两位小数。

编辑器导出后，应把变换应用到路径坐标，并移除 CSS 样式。构建时拒绝未支持的元素、属性、路径指令和图层结构，避免外观在转换时被静默丢弃。

`offerPoint` 使用连续变形场让头部轻转、双手上抬，并保持袖口与手腕的位移连续。坐标阈值针对当前角色，更换构图后需同步调整。

## 入场

`reveal.svg` 与角色使用相同坐标系。白色圆头笔画构造运行时遮罩，每条路径包含 `d`、`stroke-width`、`data-start` 和 `data-duration`。

`welcome-illustration.tsx` 统一缩放描绘时序，使最后一条轨迹在 `welcomeLogoStart` 时完成。整体节奏在 `welcome-timing.ts` 中调整，不必批量修改 SVG。

`use-startup-motion.ts` 保存本次 App 的入场资格。欢迎页、输入框和侧栏通过挂载回调参与，恢复历史会话也消费欢迎入场资格。用户按键、点击、滚动或调整窗口大小时立即完成入场。

`startup-sidebar.ts` 使用浏览器原生动画播放侧栏位移、淡入和列表错峰。列表保留可见区域测量与短期 DOM 观察，晚到的行沿同一时间线加入。结束或中断时取消动画并断开观察器，不写回内联样式。

## 待机

欢迎页空闲 5 秒后开始，每隔 18 秒以相同概率随机选择吹风或捧起，允许连续选中同一个动作，不叠加播放。吹风持续 6 秒，捧起持续 3.2 秒。

风力为 `1.8×`，由 `welcome-wind.ts` 的 `windStrength` 定义。头发沿各发束轴线做两段弧线弯曲，末段比中段晚 0.26 秒响应。头冠与描线接点固定，袖摆使用局部位移。

`welcome-wind-path.ts` 仅保留相邻采样帧，避免挂载时生成整段动作。用户操作时冻结当前风吹时间，再将轮廓柔和收回，重新等待 5 秒。窗口失焦不影响待机，页面隐藏或插画离开视口时停止并归位。欢迎页不显式处理系统的减弱动态效果设置。卸载时释放动画、计时器和事件监听。

## 验证

```sh
bun run typecheck
bunx vitest run tests/gui/welcome-wind.test.ts tests/gui/welcome-assets.test.ts
```

修改入场控制或交互行为时，构建 GUI 后运行无头浏览器定向测试：

```sh
bun run build:gui
bunx playwright test --config playwright.gui.config.ts tests/gui/welcome.e2e.ts tests/gui/welcome-startup.e2e.ts
```

角色轮廓和描绘轨迹最初来自 `.tmp-smoke/welcome-layered/vectorize.mjs` 的产物，现已保存为 SVG。构建不依赖原始像素描线过程或 Potrace。
