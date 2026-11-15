# pi-interrupt-control

将 `dot-continue` 和 `retry-before-fallback` 合为一个 Pi 扩展：用句点继续任务，在模型请求失败时先重试，再决定是否交给 Pi 回退处理。

## 功能

- 单独输入 `.` 或 `。`，继续最近尚未完成的任务。
- 每个主模型请求默认额外重试 **3 次**，间隔 **3 秒**。
- `/set-retry` 调整当前会话的额外重试次数和间隔；负数表示耗尽后直接停止。
- 重试期间只显示最新提示，结束后清理提示并保留一条重试总结；手动取消时不留总结。
- 不对其他会话、压缩、摘要或缓存预热请求额外重试。

## 安装

需要已安装 Pi 和 Node.js 22.19.0 或更新版本，无需构建。

### GitHub 安装

```sh
pi install git:github.com/llc2214926/pi-interrupt-control
```

### 本地安装

```sh
pi install /绝对路径/pi-interrupt-control
```

安装后重启 Pi，或在已有会话中执行 `/reload`。

只在一次启动中体验，且不加载其他扩展：

```sh
pi --no-extensions --extension /绝对路径/pi-interrupt-control/src/index.ts
```

### 从两个旧扩展迁移

**不要同时启用新旧扩展**，否则可能出现命令冲突或重复重试。先把旧脚本移出自动加载目录，保留备份：

```sh
backup="$HOME/.pi/agent/extension-backups/interrupt-control-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
mv "$HOME/.pi/agent/extensions/dot-continue.ts" "$backup/"
mv "$HOME/.pi/agent/extensions/retry-before-fallback.ts" "$backup/"
pi install git:github.com/llc2214926/pi-interrupt-control
```

如果曾在 `settings.json` 或启动参数中显式加载旧脚本，也应移除这些引用。完成后重启 Pi 或执行 `/reload`。

## 用法

### 继续任务

单独发送：

```text
。
```

英文句点 `.` 也可以，前后空白会被忽略。扩展发送隐藏的继续指令：空闲时启动下一轮，运行中排队，不抢先打断当前工作。它仍会进入模型上下文，并非不留记录。

包含其他文字、多个句点或图片的输入保持原样；其他扩展注入的消息不会被转换。

### 设置重试

```text
/set-retry          查看当前设置
/set-retry 10 5s    额外重试 10 次，每次间隔 5 秒，耗尽后交给 Pi
/set-retry -3 2s    额外重试 3 次，每次间隔 2 秒，耗尽后停止
/set-retry 0        关闭本扩展的额外重试
/set-retry 3        恢复默认次数和 3 秒间隔
```

- 次数必须是 `-100` 到 `100` 的整数，表示**首次请求之外**的次数。
- 间隔带小写 `s`，支持小数（如 `0.5s`），范围为 `0.001s` 到 `2147483.647s`；省略时恢复为 `3s`。
- 非法参数不会改变已有设置。
- 设置只保存在当前扩展运行时的会话内存中；重载扩展、重启 Pi 或创建新会话后恢复默认值，不写入全局配置。

## 兼容性与限制

- 优先重试需要 Pi 提供 `ModelRegistry.runtime.streamSimple`。缺少该接口时会明确报错，不能启用优先重试；句点续接仍可使用。
- 为避免失败响应中的半截工具调用被执行，回复会等一次请求完成后再显示，不逐字实时输出。
- 非负次数耗尽后仍可能触发 Pi 自带重试、压缩或其他回退扩展；`/set-retry 0` 不会关闭它们。负数耗尽后中止当前运行，不发起供应商切换。
- 所有模型请求错误都会先重试，包括认证错误和上下文超限；较大的次数和间隔会增加等待时间，也可能产生额外费用。
- 用户主动取消不会继续重试；本扩展不会自行切换模型或供应商。

## 许可

MIT，见 [LICENSE](LICENSE)。
