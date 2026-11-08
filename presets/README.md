# 示例源清单

两份可直接导入的文件，配合「设置 → 点播源 / 直播源 → 从文件导入」使用。

| 文件 | 类型 | 条数 |
| --- | --- | --- |
| `vod-sources.json` | 点播源（Apple CMS 采集站） | 13 |
| `live-sources.json` | 直播源（M3U 列表地址） | 4 |

地址均为第三方公开接口，**本仓库不控制、不背书、不保证长期可用**。2026-11-07 实测可拉取，之后随时可能失效——导入后建议先跑一次「批量测活」，再决定启用哪些。

## 点播源格式

```json
{
  "name": "我的点播源",
  "sources": [
    { "name": "示例采集站", "url": "https://example.com/api.php/provide/vod" }
  ]
}
```

`url` 必须是 Apple CMS 的 `api.php/provide/vod` 接口。可选字段：

- `detail` — 详情页根地址（少数源需要爬详情页取 m3u8）
- `isAdult` — 标记成人内容，配合「过滤成人内容」开关

也接受以下等价形态（导入时自动识别）：

- 裸数组 `[{ "name": "...", "url": "..." }]`
- 接口目录 `[{ "name": "...", "baseUrl": "..." }]`
- TVBOX 多源配置 `{ "sites": [{ "name": "...", "type": 1, "api": "..." }] }`（Spider 类站点自动跳过）

## 直播源格式

```json
{
  "name": "我的直播源",
  "liveSources": [
    { "name": "示例列表", "url": "https://example.com/iptv.m3u" },
    { "name": "带节目单", "url": "https://example.com/cn.m3u", "epg": "https://example.com/epg.xml" }
  ]
}
```

`url` 指向 **M3U 列表地址**，不是频道播放地址。可选 `epg` 为 XMLTV 节目单地址。

在直播面板里，裸数组 `[{ "name": "...", "url": "..." }]` 一律按直播源解释（点播面板里同样的数组按采集站解释）。

## 关于 M3U 频道文件

本地 `.m3u` 频道播放列表不能直接导入——本应用的直播源模型是「一个可拉取的列表地址」，频道在播放时才解析。要导入自己的 m3u，把它放到任意 HTTP 服务上，然后用那个地址添加直播源。
