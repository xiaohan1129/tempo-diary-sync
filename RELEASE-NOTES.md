# Tempo 日记同步 0.4.0

- 手动将 Crisp Tempo 当天顶层任务同步到日记，支持完成状态和任务级专注段 🍅 数量。
- Pulse 番茄热力图可读取日记 YAML tomato 属性，支持历史日期和显式 0；不与 Focus 数量累加。
- 不改写 Crisp 插件程序、数据库或 Focus 原始会话；Tempo 任务仅在主动点击时写入日记。
- 写入前备份、并发修改保护及待处理写入恢复。
- 适配已测试的 Crisp Pulse 1.34.0；Tempo 任务格式以 0.6.1 为依据。
- 23 项自动化测试通过。桌面 Mac 已验证；iPad 和 Windows 尚待实际验证。

安装：在 BRAT 中添加 xiaohan1129/tempo-diary-sync。本 Release 的 main.js 与 manifest.json 为安装附件，不含个人配置或笔记数据。
