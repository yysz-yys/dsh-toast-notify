# dsh-desktop-notify

DeepSeek Harness 的 Windows 桌面通知插件。任务**完成 / 失败 / 阻塞 / 等你操作**时弹一条系统通知，带上**工作区名字、路径、本次耗时和具体内容**，点一下直接跳到对应会话。

> Windows 10/11 · DSH `>=0.2.1-rc.2` · 零运行时依赖

## 通知长什么样

```
✅ 任务完成 · 演示应用
E:\work\demo-app · 耗时 2 分 14 秒
修复登录页样式：登录态刷新改为走 refresh token，已通过 3 个用例
```

第一行给状态和工作区名，第二行给路径和耗时，第三行给"到底成了/错在哪/在等什么"。

## 特性

- **四类触发**：任务完成、任务失败（含上下文用尽）、任务阻塞、等待你回答或确认
- **覆盖所有工作区**：监控全部活跃会话，用 `workspaceRegistry` 反查归属；不在工作区里的会话退回用它自己的目录
- **点击跳转**：点通知先唤起客户端，再跳到那条会话；会话已归档或删掉时，就只把客户端调到前面
- **中日英**：默认跟随系统语言，也可在设置页里固定
- **装进设置页**：`设置 → 通知`，不用手改任何配置文件
- **不重复打扰**：跑得比阈值短的任务不弹；同一会话的重复通知替换而不是堆叠；子代理会话默认不弹
- **重载不丢**：改配置、HMR、应用重启都不会吞掉正在跑的任务，耗时才从真实开始时间算

## 安装

### 通过插件市场（推荐）

1. `设置 → 插件 → More → 实验性插件`，打开 **自定义插件市场**
2. 在 **Discover** 里选 **Add index source**，填入：

   ```
   https://raw.githubusercontent.com/yysz-yys/dsh-toast-notify/main/market/index.json
   ```

3. 找到「桌面通知（Windows）」，点 **Install** 并确认来源

### 手动安装

克隆本仓库，把目录当作本地 bundle 安装（等价于 `plugin_manager install_bundle <目录>`），或在插件页里选择该目录。装好后在 `设置 → 通知` 里调整。

## 配置

设置页里能改：总开关、五类事件开关、语言、最短运行时长、提示音、是否包含子代理，以及「发送测试通知」。

想在配置文件里改，就把这些字段写进 profile 的 `cordis.patch.yml`（`id: desktop-notify`）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `locale` | `auto` | `auto` / `zh` / `ja` / `en`；`auto` 跟随系统区域设置 |
| `events.completed` / `.error` / `.blocked` / `.needsInput` / `.approval` | `true` | 逐类开关 |
| `includeSubagents` | `false` | 是否也通知子代理会话 |
| `minDurationMs` | `3000` | 运行短于此时长不通知 |
| `settleMs` | `1500` | idle 后的确认窗口，期间恢复运行则撤销 |
| `dedupeMs` | `5000` | 同会话同类通知的去重窗口 |
| `sound` | `true` | 是否带提示音 |
| `aumid` | `com.deepseek.dsh` | toast 归属的应用 id |
| `manageIdentity` | `true` | 是否托管 Windows 侧登记（名字/图标/点击协议/设置页条目） |
| `testOnStart` | `false` | 插件激活时先弹一条自检 |
| `debug` | `false` | 额外记录"为什么没发" |

## 为什么是 Windows only

宿主跑在 Electron 的 utility 进程里，拿不到 `electron` 模块，`new Notification()` 用不了。所以通知由一段 Windows PowerShell 5.1 调 WinRT `ToastNotificationManager` 投递——真·系统 toast，会进通知中心。

其他平台上插件保持静默，不会报错。

## 它是怎么工作的

- **触发**：监听 `turn/end` + `agent/status → idle`，两边都到齐才发；idle 后再等一个确认窗口，避免把"继续下一步"误判成"任务完成"。
- **归属**：`session/event` 里拿到会话，`workspaceRegistry` 反查工作区；`sessionTitle` 提供会话标题。
- **激活**：会把点击时带过来的会话 id 写进 `%LOCALAPPDATA%\dsh-notify\activate.json`，页面每 0.8 秒取一次并调用 `uiWorkspace.openSession()`。
- **日志**：`%LOCALAPPDATA%\dsh-notify\debug.log`（超过 1 MB 自动清空），记录每次通知的标题/内容与没发的原因。

## 卸载会清掉什么

插件从 profile 移除（或被禁用）后，最后一个实例释放 15 秒，然后删除：AUMID 登记（设置页里那一行）、`dsh-notify://` 点击协议、`%LOCALAPPDATA%\dsh-notify\` 整个目录。15 秒的宽限期用来区分"被卸载"和"应用正在退出"——正常退出不会把登记删掉。

设 `manageIdentity: false` 则完全不碰注册表。

## 已知边界

- 系统通知总开关或该应用的通知被关掉时，投递会被静默丢弃，插件只能记录"已投递"。
- 每条通知拉起一次 PowerShell，冷启动约 1–3 秒；不影响任务本身。
- 点击跳转有 1–3 秒延迟（协议拉起 PowerShell 的开销）。
- toast 三行有长度上限（标题约 64、正文每行约 110 字符），超了以 `…` 截断。

## 关于包名

本项目在插件市场里以 `dsh-desktop-notify` 列出，通过 Git 源安装。npm 上另有一个同名包（跨平台通知插件），与本仓库无关。

## 许可证

MIT。图标 `assets/app-icon.png` 取自 DeepSeek Harness 应用本身，仅用于让通知以应用身份显示，不在 MIT 授权范围内。
