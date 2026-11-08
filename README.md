# Libretv2Strm

在 [LibreTV](https://github.com/LibreSpark/LibreTV) 基础上加了 **STRM 媒体库生成**，并打包成飞牛 fnOS 原生应用（`.fpk`，内置 Node 运行时，装完即用）。

搜索到片子 → 一键生成 `.strm` + `.nfo` + 海报 → 交给飞牛影视 / Emby / Jellyfin / Infuse / Kodi 刮削播放。媒体服务器只认本地文件，播放时再向上游取流，不占 NAS 存储。

- 许可证：[AGPL-3.0](LICENSE)
- 上游：<https://github.com/LibreSpark/LibreTV>（本项目基于其 **v2.21.1**）
- **本仓库不内置任何点播源与直播源**，安装后需自行添加，见 [添加源](#添加源)

---

## 与上游的关系

LibreTV 是 Next.js 重写的影视聚合站，AGPL-3.0 开源。本项目是它的衍生版本，**保留上游全部功能**，在其上做了三类改动：

| 类别 | 内容 |
| --- | --- |
| 新增能力 | STRM 媒体库生成（12 个模块 + 5 组 API 路由 + 独立页面）、首次访问自设密码 |
| fnOS 适配 | `libretv-fpk/` 打包层：双架构 fpk、安装向导、应用中心改密、内置 Node 运行时 |
| 播放体验 | 控制栏自动隐藏延迟可调、采集站直链默认、直播源一键测活/屏蔽/播放列表编辑 |

上游 2.19.6 → 2.21.1 的更新（片头片尾跳过标记、倍速跨集保持、订阅自定义刷新周期、搜索季数精确匹配、窄屏控制条等）已全部合入。

按 AGPL-3.0 要求，本仓库公开全部源码；二次分发时请同样以 AGPL-3.0 提供源码并保留上游署名。

---

## 功能

### STRM 媒体库

- 搜索结果页 / 详情页可把整部剧或单集生成为 `.strm` 文件，同时生成 `.nfo` 与海报，命名遵循 `{title} ({year})/Season 01/{title} - S01E01` 模板（可改）
- 两种取流模式：
  - **直链（默认）**：`.strm` 里写上游 m3u8 地址，媒体服务器直接向上游取流，不经过本应用，不占 NAS 上行带宽
  - **中继**：`.strm` 指向本应用的签名代理地址，服务端统一处理 UA / Referer 防盗链，并把 m3u8 内的分片、密钥、初始化段地址全部改写为带签名的代理地址
- 生成后自动校验（拉一次 m3u8 确认可达），支持并发数与单剧集数上限
- 任务列表可查看进度、失败原因、重试

### 访问与安全

- 首次打开网页自行设置密码（4–64 位），之后在 fnOS 应用中心「设置」可改
- httpOnly cookie + HMAC-SHA256 会话，90 天有效
- STRM 播放端点用 HMAC 签名 URL 鉴权（播放器带不了 cookie），并对上游地址做 SSRF 校验

### 播放器

- 片头 / 中段 / 片尾跳过标记，按归一化剧名记忆，同剧各集与换源到同名资源都自动生效（`Shift+I/O/S/E` 标记）
- 控制栏自动隐藏延迟可调：0.5 / 0.8 / 1 / 1.5 / 2 / 3 / 5 秒或不自动隐藏，点播与直播同时生效
- 倍速跨集保持、自动连播、上一集/下一集、断点续播、外挂字幕、广告过滤

### 直播

- m3u / txt 直播源导入，分组标签条（支持鼠标拖动横向滚动）
- 一键测活：并发探测频道可用性，可一键屏蔽失效频道
- 播放列表手动编辑（增删改、排序、自定义频道名）

### 源管理

- 多采集站聚合搜索，按「源 + vodId」去重
- **点播源与直播源可分别从本地 JSON 文件导入**，按地址去重、只追加不接管已有源
- 支持 TVBOX 多源配置导入（自动抽取其中的 CMS 接口）
- 支持订阅链接（LibreTV SourceList JSON / 裸数组接口目录两种格式），可设自动刷新周期（1–365 天），打开站点时静默刷新，连续失败自动暂停

---

## 安装（飞牛 fnOS）

1. 从 [Releases](https://github.com/Ranlove99/Libretv2Strm/releases) 下载对应架构的包：
   - ARM（N100 之外的 ARM 机型、部分 RK3588 机型）：`libretv2strm-1.1.0-arm.fpk`
   - x86（大多数 N100 / J4125 / 群晖虚拟机等）：`libretv2strm-1.1.0-x86.fpk`
2. fnOS → 应用中心 → 右上角「手动安装」，选择 fpk
3. 安装向导里设置访问密码（**如果没看到这一步**，装完直接打开应用，首次进入会引导设置）
4. 打开 `http://<NAS 地址>:8099` 登录
5. 进「媒体库 → 设置」确认 STRM 输出目录（默认在共享目录下，媒体服务器可直接扫描）

> 应用名沿用 `libretv`，可与旧版 LibreTV 覆盖升级；如需并存请改 `libretv-fpk/manifest` 的 `appname` 后自行重打包。

---

## 添加源

本仓库不附带任何第三方采集接口。四种添加方式：

**1. 界面添加**：设置 → 点播源 → 新增，填 `https://example.com/api.php/provide/vod`

**2. 从文件导入**（点播源与直播源分开）：设置 → 点播源 / 直播源 → 「从文件导入」，选一份本地 JSON。

- 点播源文件支持：LibreTV 源列表 `{sources:[{name,url}]}`、TVBOX 配置 `{sites:[...]}`、接口目录 `[{name,baseUrl}]`
- 直播源文件支持：`{liveSources:[{name,url,epg}]}`，或裸数组 `[{name,url,epg}]`（直播面板里数组一律按直播源解释）
- 两个面板各吃自己那一半：文件里还有另一种源时会提示你去对面面板再导一次，不会静默丢弃
- 已存在的同地址源自动跳过；M3U **频道播放列表**不是源地址列表，会被拦下并提示先托管成 URL

仓库里有两份可直接导入的示例清单（第三方地址，2026-11-07 实测，随时可能失效，仅作起点）：

| 文件 | 内容 |
| --- | --- |
| [`presets/vod-sources.json`](presets/vod-sources.json) | 13 个点播源，Apple CMS 采集站 |
| [`presets/live-sources.json`](presets/live-sources.json) | 4 个直播源，M3U 列表地址 |

格式说明与自制方法见 [`presets/README.md`](presets/README.md)。

**3. 订阅导入**：设置 → 点播源 → 订阅，粘贴 SourceList JSON 地址，或 TVBOX 多源配置地址

**4. 部署级预置**（自建部署 / 自行重打包 fpk 时）：

```bash
export DEFAULT_SOURCES='[
  {"name":"示例采集站","url":"https://example.com/api.php/provide/vod"},
  {"name":"另一个","url":"https://example.org/api.php/provide/vod","isAdult":false}
]'

export DEFAULT_LIVE_SOURCES='[
  {"name":"示例直播源","url":"https://example.net/iptv.m3u"},
  {"name":"带节目单","url":"https://example.net/cn.m3u","epg":"https://example.net/epg.xml"}
]'

export DEFAULT_SUBSCRIPTIONS='["https://example.net/sourcelist.json"]'
```

预置源以 `env_N` 为 key 注入，用户在界面里可单独启用/禁用。三个变量的格式解析失败只会告警并整体忽略，不影响站点启动。

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080`（fpk 内为 `8099`） | 监听端口 |
| `HOSTNAME` | `0.0.0.0` | 监听地址 |
| `PASSWORD` | 空 | 访问密码。为空时走 `password.json`，首次打开网页设置 |
| `LIBRETV_DATA_DIR` | `./.data` | 应用数据目录（fpk 内为 `TRIM_PKGVAR`） |
| `STRM_DATA_DIR` | `$TRIM_PKGVAR/strm` 或 `./.data` | STRM 配置与任务数据目录 |
| `STRM_DEFAULT_OUTPUT_DIR` | 共享目录 / `$STRM_DATA_DIR/library` | `.strm` 默认输出目录 |
| `STRM_LOCAL_PORT` | 空 | `PORT` 未设时的兜底端口，用于推导中继模式的播放地址 |
| `PROXY_SECRET` | 空 | STRM 播放签名密钥。不设则由 `PASSWORD` 派生——**改密码后旧 `.strm` 会失效，需要重新生成**；多实例共用一个密钥时请显式设置 |
| `DEFAULT_SOURCES` | 空 | 预置点播源 JSON 数组 |
| `DEFAULT_LIVE_SOURCES` | 空 | 预置直播源 JSON 数组 |
| `DEFAULT_SUBSCRIPTIONS` | 空 | 预置订阅地址 JSON 数组 |
| `DEFAULT_IMAGE_MODE` | `direct` | 封面图加载方式默认值（`direct` / `proxy`） |

---

## 从源码构建

需要 Node.js 22+。

```bash
cd libretv
npm ci
npm run dev        # 开发，http://localhost:8080
npm run typecheck  # tsc --noEmit
npm test           # vitest，627 项
npm run build      # 产出 .next/standalone
```

打 fpk 见 [docs/打包说明.md](docs/打包说明.md)（需要预先准备两套 Node 运行时与 sharp 原生模块）。

---

## 目录结构

```
Libretv2Strm/
├── libretv/                  Next.js 应用
│   └── src/
│       ├── app/              页面与 API 路由
│       │   ├── api/strm/     STRM：catalog / config / files / play / tasks
│       │   └── strm/         媒体库页面
│       ├── components/       播放器、源管理、直播、跳过标记等
│       └── lib/
│           ├── strm/         STRM：base-url / generator / naming / nfo / poster / play / sign / tasks / verify
│           ├── control-hide.ts  控制栏隐藏策略（单一来源）
│           ├── source-file-import.ts  本地源文件解析（点播 / 直播分开）
│           └── skip-marks.ts    片头片尾跳过标记
├── presets/                  可直接导入的源清单示例（点播 / 直播各一份）
├── libretv-fpk/              fnOS 打包层
│   ├── manifest              应用元数据（版本、端口、changelog）
│   ├── cmd/                  启停脚本（main / install_callback / config_callback …）
│   ├── wizard/               安装、改密、升级、卸载向导
│   ├── ui/                   桌面图标与入口
│   └── config/               权限与资源声明
└── scripts/pack-fpk.sh       双架构打包脚本
```

---

## 许可

[GNU Affero General Public License v3.0](LICENSE)。

本项目基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV)（AGPL-3.0）修改，主要改动见 [NOTICE](NOTICE)。上游版权归其贡献者所有。

第三方采集站、直播源的内容与可用性由各站点自行负责，本仓库不附带、不背书任何此类地址。
