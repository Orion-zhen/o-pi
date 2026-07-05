# 测试组织

测试按运行模块分目录：`bash-tool`、`file-tools`、`stats`、`subagent`、`system-prompt`、`tui`、`web-tools`。

优先测试稳定行为边界：参数 schema、文件/网络安全、错误结构、缓存、渲染不崩溃和关键数据不泄露。避免测试提示词、工具描述或 UI 文案的完整措辞；只有安全边界或公开接口依赖这些文本时，才做最小结构断言。
