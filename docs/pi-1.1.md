# Pi 1.1.0 增量适配（基于 v0.0.9）

本轮最终基线是远端 `5fa2158`（v0.0.9），不是旧的 v0.0.7。
同步时完整保存了旧工作区，之后选择性移植仍然需要的修改，没有整体套用旧补丁。

## 上游已实现，本轮不重复修改

- `registerToolRenderer()` 集中管理基础工具和 codemode 展示。
- codemode 完全由 Pi 注册和激活；中文脚本指导通过选中工具的 prompt section 注入。
- 删除 codemode 执行接管、设置管理、Proxy 和 journal。
- 删除 `/diff` 和插件 Markdown 增强；保留单次 edit/write 差异。
- `generate_image` 已使用原生 ModelRuntime、结构化路径、取消传播和单次 usage 计费。
- 图像文件已经随机命名、独占创建并采用 0600 权限。
- 共享刷新器、组件复用、模型分类/生图记录与费用展示。
- FFF 只支持 `@ff-labs/pi-fff@0.11.0`，不恢复 legacy 配置或版本矩阵。
- 宿主 peer 仍为 `"*"`，遵循上游选定的 Pi 包规范，不误改为另一个依赖策略。

## 本轮新增

| Pi 变化 | 增量修改 |
| --- | --- |
| 1.1.0 `durationMs` | 基础/codemode 父卡片使用渲染上下文，子调用使用执行结束事件；不再写入自算的 `piLiuovoElapsedMs`，不从 codemode 文字解析时长 |
| 1.1.0 `outputPad` | 两类卡片使用宿主双侧边距；组件复用时更新边距并失效缓存，覆盖零边距、窄屏和零宽 |
| 1.1.0 `agent_settled.aborted` | 标题直接使用权威取消字段，修复重试等待期取消；删除旧信号缓存 |
| 当前开发基线 | coding-agent/tui 开发依赖与验收脚本固定到 1.1.0；FFF 宿主门槛同步，FFF 自身仍是 0.11.0 |

模型调用不是普通工具执行事件，继续使用 Pi 原生 codemode records 中的
`durationMs` 和 `cost`；最终模型记录在保存快照前同步，避免丢失费用或状态。
参数生成不计入执行时间，原有准备态、统一计时器及资源清理保留。

## 原生继承与验证

- 1.0.3–1.0.4：图像读取返回块、`image()` 保存路径和私有权限。
- 1.0.4–1.1.0：异步工具发现、工具指南、文本输出项分隔和 console 块。
- 1.1.0：图像分类与新模型无需 UI 按 provider/model 写分支；保留上游模型运行时。
- `--tools +name/-name`、通配、`--no-mcp`、OAuth、连接生命周期、重试与计费由 Pi 处理。
- OSC 7501 由 Pi 发送；插件仅维护标题，不写重复状态。
- Azure provider 更名属于用户的 auth/models/settings 迁移，不由 UI 插件改写凭据。

真实宿主离线测试覆盖原生 loadout、图像生成与单次费用、读取图像后显示和落盘、
异步工具指南、输出边界、时长与边距、回放/HTML 导出、取消与标题。
模型服务使用替身，禁用网络，不产生模型费用。

另通过固定 Pi 1.1.0 + FFF 0.11.0 的临时安装测试，覆盖 user/project/combined
scope、真实搜索、commands/flags、补全和 shutdown。
本轮未重跑真实 PTY 测试；安装与逻辑测试不等于人工终端视觉验收。

已升级到 v0.0.9 的用户不需要额外的 codemode ownership 迁移。
仍使用更旧接管版本的用户，应遵循 README 中既有的 breaking upgrade 步骤；
本轮不会把那套已删除的兼容逻辑加回来。
