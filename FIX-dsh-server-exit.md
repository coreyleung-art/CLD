# 修复：`The dsh server exited (code 1, signal null)` / `--profile <name> is required`

修复日期：2026-08-16
已应用位置：`/Applications/CLD.app/Contents/Resources/app.asar`（已安装的 App 已直接打好补丁）

## 症状

每次以「服务器模式」启动 CLD（设置了 `CLD_BIND_HOST`，例如用 `serve.sh` 或 launchd 的
`com.cld.server` 运行），dsh web 立即退出，弹出：

```
The dsh server exited (code 1, signal null).
Last log lines:
error: --profile <name> is required
Full log: ~/.cld/logs/dsh-web.log
```

日志里对应这段：

```
[cld] server mode: public 0.0.0.0:3081 via inject-proxy (mobile css, trusted: )
error: --profile <name> is required
```

## 根因

CLD 主进程 `main.js` 的 `spawnDsh()` 在服务器模式下，把 `--trusted-host <host>` 参数
放在了 `web` **之前**：

```js
// 旧代码（有 bug）
const dshArgs = ["--expose-internals", bin];
if (CFG.bindHost) {
  const autoTrusted = collectTrustedHosts();
  for (const h of autoTrusted) dshArgs.push("--trusted-host", h);   // ← 在 web 之前
  for (const h of CFG.trustedHosts) dshArgs.push("--trusted-host", h);
  dshArgs.push("web", "--port", "0");
  ...
}
```

实际生成的命令行是：

```
CLD --expose-internals .../bin.js --trusted-host coreymac-mini.taild3fd86.ts.net web --port 0
```

dsh 的启动器（`@deepseek-ai/dsh/lib/bin.js`，用 commander 解析）只认识自己的一小撮
参数（`--profile`、`--patch`、`--dump-config`…），遇到不认识的首个 token 就把它当成
「内部参数起点」。`--trusted-host` 排在 `web` 前面，commander 把 `--trusted-host` 及其
值当作位置参数消费后，`web` 就不再被识别为子命令 → 触发根命令的 action → 由于没有
`--profile`，直接报错 `--profile <name> is required` 并以退出码 1 退出。

`--trusted-host` 是 dsh web 应用自身的参数（/api 信任围栏），必须放在 `web` **之后**。

> 注意：日志里 `trusted: ` 显示为空并不代表没有传 host —— 那一行只打印自动收集的
> Tailscale/LAN IP（`autoTrusted`），`CLD_TRUSTED_HOSTS` 里的 host 没有打印出来。

## 修复

把 `web --port 0` 放进初始化数组，`--trusted-host` 一律追加到 `web` 之后：

```js
// 新代码（已修复）
const dshArgs = ["--expose-internals", bin, "web", "--port", "0"];
if (CFG.bindHost) {
  const autoTrusted = collectTrustedHosts();
  for (const h of autoTrusted) dshArgs.push("--trusted-host", h);
  for (const h of CFG.trustedHosts) dshArgs.push("--trusted-host", h);
  logStream.write(`[cld] server mode: public ${CFG.bindHost}:${CFG.port ?? SERVER_DEFAULT_PORT} via inject-proxy (mobile css, trusted: ${autoTrusted.join(", ")})\n`);
}
```

生成的实际命令行变为：

```
CLD --expose-internals .../bin.js web --port 0 --trusted-host coreymac-mini.taild3fd86.ts.net
```

验证：该命令可正常启动 dsh web 并输出 `dsh web: http://127.0.0.1:<port>`。

## 已做的事

- 备份原文件：`/Applications/CLD.app/Contents/Resources/app.asar.bak-20260816`
- 替换为修复版：`/Applications/CLD.app/Contents/Resources/app.asar`
- 修复后的完整 `main.js` 存于本目录 `main.js.fixed`（可与源工程对比 / 直接使用）

## 下次从源码构建时

在 CLD 源码仓库的 `main.js`（`spawnDsh()`）里应用上面同样的改动（把 `web --port 0`
移到数组初始化处，`--trusted-host` 放在 `web` 之后），再重新 electron-builder 打包即可。
