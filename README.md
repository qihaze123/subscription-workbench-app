# 订阅工作台

在浏览器里维护 Clash / Mihomo 订阅。可以合并订阅源、编辑策略组和分流规则、保存草稿、比较历史并发布。客户端刷新时拉取已发布的配置。

## 本地运行

需要 Python 3.10 或更新版本。全新的数据库会加载虚构的桌面和手机示例。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m backend.app
```

打开 [本地管理后台](http://127.0.0.1:18861/)。要从空库开始，在启动命令后加 `--empty`。也可以用 `--data /path/to/workbench.sqlite3` 指定数据库。

如果只需要前端和 API 预览，可用 Node.js 20 或更新版本运行 `npm start`，打开 [预览页面](http://127.0.0.1:3000/)。`npm test` 会在独立的临时数据目录运行测试。

## 配置私有数据

复制 `.env.example` 为 `.env`，填写需要的项，然后在启动前加载它。

```bash
set -a
. ./.env
set +a
```

订阅源的地址和节点配置在本地后台录入，保存在本地 SQLite。默认数据目录是 `data/`，可用 `WORKBENCH_DATA_DIR` 修改。运行时数据库、导出文件、令牌及配置同样需要通过私有渠道备份。

常用的可选配置都在 `.env.example` 里。配置 `WORKBENCH_MIHOMO` 可启用测速，配置 `WORKBENCH_MOVPN_DB` 可启用共享网段同步。迁移带本地文件引用的历史数据库时，按需指定对应的 YAML 文件路径。

## 通过 Tailscale 访问

本机管理端口默认是 `18861`。需要远程订阅时，把下方的示例主机名换成部署机器的 Tailscale 域名，运行一次初始化命令。它会在私有数据目录生成下载令牌，`--listen-port` 和 `--https-port` 可设置下载端口。

```bash
.venv/bin/python -m backend.distribution init --hostname workbench.example-tailnet.ts.net
```

订阅下载入口默认由 Tailscale Serve 的 `8443` 转发到本机的 `18862`。如果需要远程管理，把 `examples/tailnet-admin.example.json` 复制到 `data/private/tailnet-admin.json` 并填写授权账号，再让 Serve 把 `9443` 转发到本机的 `18863`。管理端口会检查 Serve 提供的登录标识。订阅链接和下载的 YAML 都可能用于访问代理节点，应当按凭据保管。

公开规则集的目录和内容来自 [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)。
