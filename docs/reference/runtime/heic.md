# HEIC 解码依赖

GUI 附件、文件查看器和 read 共用 `libheif-js` 的 WASM 解码器。入口为 `libheif-js/libheif-wasm/libheif-bundle.mjs`，WASM 内嵌于模块，不从 CDN 加载。

附件和 read 只解码主图并编码 PNG。浏览器使用 OffscreenCanvas，将 PNG Blob 直接传回主线程。后端复用 `@napi-rs/canvas`。每次转换结束或取消后终止 Worker。

GUI 附件携带原文件的图片数量，宿主在分流内置命令、Shell 和已注册扩展命令后生成多图说明，输入历史保留原文。SDK 模板和 skill 命令仍接收拼接后的文本，附件说明尚未与模板参数完全隔离。

文件查看器下载一次原文件，按索引解码当前图片，将像素直接传给 Canvas，不经过 PNG/JPEG 编码。每次解码后释放 libheif 上下文，切换或关闭文件时终止 Worker 并释放原文件及画布。浏览器使用静态 Worker，后端使用资源目录中的 `heic-worker.mjs`。不调用系统转码命令，不修改 libheif-js 的实现。

## 源码

源码和构建入口：

- [libheif-js](https://github.com/catdad-experiments/libheif-js)：npm 包装和打包脚本，实际版本见 `package.json` 与安装结果。
- [libheif-emscripten](https://github.com/catdad-experiments/libheif-emscripten)：WASM 构建及 libheif 子模块版本。
- [libheif](https://github.com/strukturag/libheif)：解码器及 Emscripten 构建脚本。
- [libde265](https://github.com/strukturag/libde265)：HEVC 解码实现，其版本由上游构建脚本指定。

使用行为见 [GUI 附件](../../guides/gui.md)、[文件查看器](../gui/workspace.md#图片) 和 [read](../file-tools/read.md)。
