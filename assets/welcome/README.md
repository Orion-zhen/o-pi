# 欢迎页资产

SVG 是编辑源，`src/gui/frontend/app/welcome/art/*.json` 是生成结果，不手工修改 JSON。

| 编辑源 | 生成结果 | 职责 |
| --- | --- | --- |
| `character.svg` | 各图层 JSON | 基础轮廓、透明度和绘制顺序 |
| `scripts/welcome/svg.ts` 中的 `offer` | 路径目标轮廓或图层平移量 | 从基础轮廓生成捧起姿态 |
| `reveal.svg` | `reveal.json` | 入场描绘轨迹、笔宽和时序 |

`concept.png` 仅作设计参考，不参与生成。生成器不依赖 `.tmp-smoke`、Potrace 或运行时 SVG 解析。

## 编辑与生成

1. 修改 SVG 或 `offer` 变形函数。
2. 运行 `bun run generate:welcome`。
3. 运行 `bun run check:welcome` 和 `bunx vitest run tests/gui/welcome-assets.test.ts`。
4. 将编辑源和生成结果一起提交。修改轮廓或动作后，另行检查视觉效果。

生成命令从仓库根目录运行。校验命令只读文件，检查生成结果是否逐字节一致，不自动修复差异。GUI 构建直接使用已提交的 JSON。

## 角色轮廓

`character.svg` 使用 `viewBox="420 24 680 730"`，外层绘制分组为 `fill="currentColor"`。`color` 只用于 SVG 预览，运行时继承界面颜色。

图层按以下顺序绘制，与 `welcome-illustration.tsx` 一致：

```text
hair, face-neck, collar, body,
left-sleeve, right-sleeve, left-hand, right-hand
```

每层直接包含路径，路径显式设置 `fill-opacity`。路径标识用于编辑和错误定位，图层内顺序决定叠放顺序。

角色路径只使用显式绝对 `M`、`L`、`C`、`Z` 指令，每组坐标前都写指令。生成器保留基础路径，对同一组坐标应用 `offer`，因此两个姿态的路径拓扑始终一致。目标坐标保留两位小数。

左手的目标轮廓全部等价于平移 `(-2, -18)`，因此 JSON 只保存图层级 `offer: { x: -2, y: -18 }`，不重复保存每条路径的目标轮廓。运行时用 `motion.g` 移动整个左手，其余图层继续使用路径插值。生成器逐条校验两种表达是否等价，修改后的轮廓若超出纯平移区域会报错，不能静默改变动作。

编辑器导出后，应把变换应用到路径坐标，并移除 CSS 样式。生成器会拒绝未支持的元素、属性、路径指令和图层结构，避免外观在转换时被静默丢弃。增加图层或改变图层顺序时，须同时修改生成器和渲染器。

当前 `offer` 使用连续变形场让头部轻转、双手上抬，并保持袖口与手腕的位移连续。其坐标阈值针对当前角色。更换构图后需同步调整，不是通用骨骼系统。

## 入场描绘

`reveal.svg` 与角色使用相同的坐标系。白色圆头笔画用于构造运行时遮罩，不是角色填充轮廓的副本。

每条路径包含：

- `d`：描绘轨迹。
- `stroke-width`：遮罩笔宽。
- `data-start`：原始开始时间，单位为秒。
- `data-duration`：原始持续时间，单位为秒。

这些时间不等于最终播放时间。`welcome-illustration.tsx` 按最后一条轨迹的结束时间统一缩放，使描绘在 `welcomeLogoStart` 时完成。整体入场节奏在 `welcome-timing.ts` 中调整，不必批量修改 SVG 时序。

## 来源

现有角色轮廓和描绘轨迹来自 `.tmp-smoke/welcome-layered/vectorize.mjs` 的产物。角色基础轮廓已保存为 SVG，捧起姿态的变形函数已迁入正式生成器，描绘轨迹已保存为独立 SVG。首次迁移时校验了全部 9 个 JSON，内容保持不变。之后将左手的重复目标轮廓改为等价的图层平移。原始像素描线过程不属于日常资产生成流程。
