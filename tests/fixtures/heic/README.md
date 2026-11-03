# HEIC 测试图片

本仓库生成的纯色测试图，无外部素材。

- `split.heic`：64×32，左红右绿。
- `rotated.heic`：同一图像，容器标记顺时针旋转 90 度，显示尺寸为 32×64。
- `multiple.heic`：第一张为 16×16 蓝色，第二张为 64×32 红绿图，第二张设为主图。

生成工具：ImageMagick、libheif 1.23.7 的 `heif-enc`，HEVC 质量 95，`-p x265:pools=none`。多图使用两个 PNG 输入，生成后将 `pitm` 的主图 ID 改为第二张图的 ID。测试直接使用这些文件，不要求安装生成工具。
