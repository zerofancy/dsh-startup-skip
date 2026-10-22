# DSH Startup Skip · 跳过启动登录

<img src="icon.svg" width="72" height="72" alt="直接进入工作区" />

**简体中文** | [English](README.en.md)

一个非官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面端 Host 插件：**当你已经通过第三方插件接入模型时，不必在每次冷启动时再走 DeepSeek 登录或填写 API Key 的欢迎页。**

无需修改官方安装包，无需保存占位 Key。安装一次、完整重启后生效。

> **版本相关的兼容补丁，不是模型授权工具。** 本插件有意为一次启动检查返回合成的 `configured: true` 元数据；它不代表真实 API Key，不提供模型、额度或账号授权，也不会绕过模型提供方的认证、计费或访问限制。

## 适用范围

| 项目 | 当前范围 |
| --- | --- |
| 插件版本 | `0.1.0` |
| DSH 桌面版 | **严格限定 `0.2.1-rc.2`** |
| 形态 | Host-only bundle，无运行时第三方依赖、构建步骤或安装脚本 |
| 使用前提 | 已有可用的模型接入方式，例如独立授权的 ChatGPT 套餐插件 |
| Web / CLI | 不适配，保留官方行为 |
| 许可 | [MIT](LICENSE)，包括原创 SVG 图标 |

本项目不隶属于 DeepSeek 或 OpenAI，也不依赖某个 ChatGPT 插件的私有账号格式。

## 为什么需要它？

当前目标版本的桌面启动判断只认两种状态：DeepSeek 账号已登录，或已配置模型 API Key。第三方插件自己的 OAuth 授权不一定出现在这个检查里，因此即使模型能用，欢迎页仍可能出现。

本插件表达的是一项明确的本地偏好：**允许我不配置上述两条认证路径，直接进入工作区，模型访问继续交给已有插件。**

## 安装

### 通过 DSH 插件管理

在 DSH 中请求安装并启用以下 GitHub bundle，批准安装操作：

```text
github:zerofancy/dsh-startup-skip
```

这是 GitHub 源码安装，不是 npm 包名；仓库中的包名保留为 `@local/dsh-startup-skip`，`private: true` 仅防止误发 npm，不影响 GitHub 安装。

### 通过终端

如果已经安装并配置了 DSH 的 `dsh` 命令，可在**完整退出桌面应用后**运行：

```sh
dsh plugin --profile desktop add github:zerofancy/dsh-startup-skip
```

需要能访问 GitHub 及 DSH 安装过程所需的包仓库。没有 `dsh` 命令时，请使用插件管理方式，而不是另装一套不同版本的 DSH。

### 从本地源码安装

```sh
git clone https://github.com/zerofancy/dsh-startup-skip.git
```

然后通过 DSH 插件管理安装克隆目录的**绝对路径**。目录安装可能链接源码，请保留目录，不要在安装后移动或删除它。

## 使用

1. 确认当前 `desktop` profile 中「**跳过启动登录**」已启用。
2. 从应用菜单或系统托盘**真正退出** DSH；仅关闭窗口可能只是隐藏到托盘。
3. 重新启动，检查是否直接进入工作区。
4. 保持或手动选择原来的模型。模型未授权、额度耗尽或网络异常仍须由对应模型插件处理。

插件不会主动重启应用。运行中安装不会重新执行当前窗口的欢迎页判断；热重载或禁用后重新启用，也不应视为一次新的冷启动。

## 工作原理

插件使用已通过官方访问认证的 `connection/request` HTTP 钩子，识别同一调用特征的串行启动查询：

```text
productAnalytics/enabled
  → settings/describe
  → llm/listConfigurableProviders
  → credentials/describe
```

前三个成功响应只校验并原样传递。最后一个成功响应如果没有真实的 `configured: true` 项，就追加一个明确属于本插件的临时策略标记。目标版本的原生欢迎页通过 `Object.values(...).some(configured)` 计算是否可以继续，因此会进入工作区。

随后插件在本次 Host 进程中停止适配，**后续凭据查询保持真实**。如果本来已经存在配置好的真实凭据，则不添加标记，直接结束。

这项一次性限制很重要：后续首次引导也会查询 API Key 状态，持续伪报可能触发显示偏好和 Coding Tools 的自动设置。插件不替换全局 Credentials 服务，不注册虚拟供应商，也不改变 Host 内部直接读取凭据的结果。

## 数据与安全边界

- **不写假 Key，不读取账号或凭据文件，不读取第三方插件的 token 存储。** 兼容检查只读取桌面程序包版本与启动代码。
- 运行时会短暂检查目标 RPC 响应中的设置/供应商/凭据元数据，并在内存中对请求 Cookie 与 User-Agent 计算 SHA-256 摘要来关联候选调用。摘要不落盘；日志不输出请求头、响应体、凭据引用或 token。
- 不关闭 HTTP 身份认证、Host/Origin 校验，不绕过更新检查；请求必须先由 DSH 官方连接层正常接纳。
- `productAnalytics/enabled` 仅作为启动序列特征；插件不改变统计开关、不额外发送统计请求。
- 无 Origin/Referer、loopback 地址和请求摘要只是**启发式筛选，不是原生欢迎页专属身份凭证**。其他已认证本地客户端理论上也能产生相同序列。
- 只缓冲目标普通 JSON 响应，每个最多 **256 KiB**；从首阶段起，后续候选请求需在 **30 秒**窗口内进入。该窗口在请求入场时检查，并非整个响应的完成期限。遇到错误、未知结构、压缩、超限、并发歧义或中断时停止本轮适配，保留原有响应/错误语义。

## 兼容性与已知限制

1. 只支持 `0.2.1-rc.2`，还会检查启动代码的特征。版本或代码不匹配时保留官方行为。**不要通过版本豁免强行启用未知版本。**
2. 不只是 `needsWelcome()` 判断本身，启动时序、RPC 格式、响应写出机制和凭据聚合方式也属于兼容条件。
3. 原生检查必须至少查询一个模型凭据引用；若根本不调用 `credentials/describe`，插件无法触发。
4. 仅覆盖冷启动；不承诺屏蔽主动退出 DeepSeek 账号、账号失效、异常恢复或任意 Host 单独重启时的所有欢迎提示。
5. 不检测第三方 OAuth 是否真正可用，不自动切换模型，不授予额外工具权限或模型访问权限。
6. 公开的 `connection/request` 钩子不等于官方支持此欢迎页 workaround；其余协议细节属于版本相关实现。

## 验证状态

- 已在开发环境完成 **53 项自动化测试**，包括真实 Node HTTP bridge 模拟、并发、一次性修改、UTF-8 分块、响应长度、断线、卸载及异常恢复。
- 已在目标桌面 profile 完成本地安装，安装工具返回 `application: applied`，并确认运行时条目存在。
- **发布时尚未收到完整冷启动的人工验收结果。** 自动化测试和安装成功不能替代桌面端实测；目前不宣称 Windows/macOS 的完整端到端验证均已通过。

欢迎报告测试结果。建议检查：连续两次冷启动能进入工作区、原模型仍能正常对话、显示偏好和 Coding Tools 未改变，以及禁用后重启恢复官方行为。

## 恢复与卸载

在插件管理中禁用「跳过启动登录」，再完整退出并重新启动 DSH，即恢复官方启动行为。也可通过插件管理移除 `@local/dsh-startup-skip` bundle。

本插件没有保存占位 Key，无需删除凭据或撤销模型账号授权。禁用不会主动关闭已经打开的工作区。

## 故障排查

| 现象 | 检查方向 |
| --- | --- |
| 安装后仍出现欢迎页 | 是否完整退出；profile 是否正确；插件是否启用；DSH 是否恰为支持版本 |
| 日志显示 `unsupported-runtime-version` / `unsupported-desktop-protocol` | 兼容保护已生效，等待适配；不要强行关闭版本检查 |
| 日志显示 `ambiguous-startup-sequence` / `startup-window-expired` | 本轮已保守停止适配，检查插件冲突或启动延迟 |
| 日志显示 `not-desktop-host` / `compatibility-check-unavailable` | 当前启动形态或程序布局不符合已适配路径，保留官方行为 |
| 进入工作区后模型不能回复 | 检查原模型插件的授权、额度及网络；本插件不处理推理认证 |

提交 Issue 时请提供 DSH/插件版本、操作系统、复现步骤及上述固定诊断分类。**不要上传账号文件、Cookie、token、完整请求/响应或未经脱敏的日志。**

## 开发

建议使用 Node.js 24 或更新版本。测试无需 `npm install`、外网或真实账号：

```sh
npm test
```

等价命令：

```sh
node --test --test-isolation=none test/*.test.js
```

测试关闭子进程隔离，便于在不允许命名管道的 Windows 沙箱中运行；部分测试仍需绑定本机 loopback 端口。

| 文件 | 职责 |
| --- | --- |
| [index.js](index.js) | Host 生命周期、进程级一次性状态及钩子注册 |
| [compatibility.js](compatibility.js) | 只读版本和启动代码特征检查 |
| [core.js](core.js) | 启动序列状态机与有界响应适配 |
| [cordis.patch.yml](cordis.patch.yml) | 插件 bundle 挂载声明 |
| [test/](test/) | HTTP 集成与异常路径回归测试 |

当前仓库仅从 GitHub/本地目录分发，不发布 npm。提交兼容性改动时，请附对应 DSH 版本和回归证据，而不是简单放宽版本范围。

## 许可

[MIT License](LICENSE) · Copyright © 2026 zerofancy and contributors。

代码及本项目原创 SVG 图标均按 MIT 许可提供。DeepSeek、OpenAI 等名称仅用于说明兼容对象，不表示官方认可或背书。
