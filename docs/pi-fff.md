# pi-fff integration contract

当前自用基线只有 **Pi 1.1.0 + `@ff-labs/pi-fff@0.11.0`**。FFF 是可选的独立 Pi 包，不随 grove 分发，也不是 peer dependency。

不再适配旧 `pi-fff` 包、旧 scoped 版本或维护历史验证矩阵。改变 FFF 版本前需要重新审查其注册接口并更新验收；不支持的版本会得到 `PIFFF_VERSION_UNSUPPORTED`，不会尝试原生重试或猜测兼容分支。

## Execution and rendering

- 捕获当前 FFF 的 `ffgrep`、`fffind`，只以公开名称 **`grep`、`find`** 注册。
- grove 保留 reasoning schema 增强和紧凑渲染；转发执行前去掉自己注入的 reasoning。
- **`read` 始终由原生 Pi 执行**，不再提供旧 FFF 的 fuzzy read。
- 保留源工具元数据、参数、接收者、取消信号、更新回调、返回值与错误语义；不重复计费，也不在失败时偷偷换执行器。
- 当前 FFF 的 flags、commands、autocomplete 和生命周期回调按源顺序转发一次。使用 `tools-and-ui` 或 `tools-only`，不使用会与公开名称冲突的 `override` 模式。
- 当前 FFF 仍导入 `@sinclair/typebox`，因此将其映射到运行中 Pi 的共享 TypeBox。旧 Pi 包名别名已删除。

基础工具和 FFF 的真正行为包装保留；展示独立注册。**codemode 不属于 FFF 的所有权管理**，只通过 `registerToolRenderer()` 展示，执行、激活、sandbox 和输出限制均由 Pi 负责。

## Setup and teardown mechanics

```bash
pi install npm:@ff-labs/pi-fff@0.11.0
# 或项目安装：pi install -l npm:@ff-labs/pi-fff@0.11.0
```

在 Pi 中运行：

```text
/grove setup
/grove status
/grove teardown
```

这些命令只管理 FFF：

1. setup 先验证所有发现的用户/项目参与方，再显示预览并请求确认。
2. 将选中的 package entry 改为 object form，设置 `extensions: []`，避免 standalone FFF 与适配器重复注册。
3. 每个 settings 文件旁的 `grove.pi-fff.json` 保存精确的 prior/managed entries。原本已经 filtered 的配置也需要所有权日志。
4. 所有设置到位后，关联日志先持久化为 `reload-pending`，再跨越一次 reload。
5. 新实例启动后确认目标状态，完成 setup 日志提交；teardown 则恢复 prior entries 并退休日志。旧命令栈不在 reload 后重新声明执行所有权。

FFF 缺失时不会安装任何东西，也不会设置 codemode。setup/teardown **从不修改 `defaultTools` 或 `builtin:codemode` directives**。非交互环境不写设置；取消、验证失败和 drift 均不静默覆盖文件。

从旧 codemode 接管版本升级时，先使用**旧版 `/grove teardown`**恢复旧的 codemode 和 FFF 配置，然后换新版、启用原生 codemode，再按需 setup FFF。完整步骤见 [README](../README.md#breaking-upgrade)。不要先删除旧日志。

## Ownership and scope

`/grove status` 报告：

| State | Meaning |
| --- | --- |
| `absent` | 使用 grove 展示的原生工具 |
| `standalone` | FFF 独立加载自己的 raw tools；尚未建立 grove 管理 |
| `filtered-unmanaged` | FFF 被过滤但没有日志；仍提供 grove 原生工具，需要显式 setup |
| `managed-compatible` | 原生 read；FFF 执行公开 grep/find；grove 提供 reasoning 和渲染 |
| `managed-invalid` | 验证失败时保留原生路由；组合提交失败或部分回放必须按具体诊断处理 |
| `recovery-pending` | 保留 grove 原生工具，等待一次 reload 完成日志恢复 |
| `disabled` | grove 不注册工具覆盖或渲染；已存在的 FFF 设置和日志不被开关命令修改 |

项目 package entry 优先于用户 entry；损坏的项目安装不会回退到用户版本。重复 entry 会被拒绝。setup 验证并记录当前发现的所有 scope；teardown 恢复每个 scope 的精确来源和附加字段。

旧 `pi-fff` 包不再参与发现或适配，应在切换前移除其旧配置。旧身份的恢复日志会被拒绝，而不是自动迁移。

如果发生 `PIFFF_FORWARD_PARTIAL`，状态明确显示 **`unsafe partial registration; reload required`**：此时不能继续相信部分注册后的工具所有权，先 `/reload`。它与注册前失败、可以保留原生工具的情况不同。

## Verification policy

`validated` 只表示：匹配当前固定版本，并通过所需的注册结构检查。它不是跨版本兼容承诺，也不等于远程 registry 完整性认证。

适配器离线核对本地 manifest、canonical path 和可用 lockfile；有本地 integrity 但未取得 registry 对照时会明确标记 `registry-unverified`，不会为了启动去访问 registry。

验收命令：

```bash
npm run check
npm test
npm run test:pack
npm run test:host-smoke
npm run test:pi-fff-installed
npm run test:pi-fff-tui
PI_FFF_TUI_MODE=regular npm run test:pi-fff-tui
npm run probe:pi-fff-installed
```

- host smoke 使用临时设置、真实 Pi 1.1.0、真实原生 codemode 和桩模型/生图 provider，禁用网络请求。覆盖渲染解析、schema/执行所有权、嵌套取消、输出上限、mode/inlineBudget、usage、回放、HTML 导出和主题切换。
- installed smoke 在临时目录安装固定组合，覆盖 user、project、combined scope，真实 FFF 搜索、flags/commands、空格路径补全及 shutdown。
- TUI smoke 默认 fullscreen；需要 Linux 的 util-linux `script(1)`、PTY 和 npm 访问，验证真实卡片、autocomplete/Escape、`/reload`、`/new`、`/quit` 与资源清理。它不再循环旧版本矩阵。
- probe 只读检查实际安装的 Pi/FFF，断言用户 settings 的字节和文件元数据不变，不转发真实注册，也不执行 setup。若 PATH 中只有 shell 启动器或没有 Pi，设置 `PI_GROVE_PI_CLI` 为实际安装包的 `dist/cli.js`，并按需设置 `PI_CODING_AGENT_DIR`。

网络/PTY 环境不足不是通过；查看命令日志区分阻塞与真实失败。终端图片协议和视觉效果仍需在实际使用的终端手动确认，不能用逻辑或 PTY 测试替代。

## Drift, recovery, and removal

**卸载 grove 或被管理的 FFF 前先 teardown。**

中断事务在启动时恢复：完整的 `reload-pending` 目标状态可以最终提交；较早的中断可能需要一次手动 reload。drift、损坏日志或关联文件缺失会停止自动恢复，并报告具体路径。

若必须手工恢复：

1. 先备份所有关联 settings 和 `grove.pi-fff.json`。
2. 对照每个日志的 `settingsPath`、`entryIndex`、`priorEntry`，核实当前位置，再恢复对应 package entry；不要覆盖整个 settings 文件或其他 package entries。
3. 检查全部 scope 一致后才删除已退休日志，最后 `/reload`。
4. 不要把项目 entry 复制到用户 scope，也不要把手工造出的 sidecar 当作 setup。

codemode 的历史 `grove.codemode.json` 不由新版本读取或迁移。必须在升级前用旧版本恢复，或依据备份人工还原其记录的 directives。原生 codemode 最终应保持加载，是否激活由 Pi 工具选择决定。
