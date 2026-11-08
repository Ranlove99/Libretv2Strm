import { parseSubscriptionJson, parseSubscriptionPayload } from './tvbox-parser';
import { hostnameOf, normalizeUrl, optionalString } from './source-list';
import type { LiveSourceConfig, SourceListPayload, SourceConfig } from './types';

/**
 * 本地源文件的解析层：把用户从磁盘选中的 JSON 文件转成可直接入库的源列表。
 *
 * 与「数据源订阅」共用同一套解析器（LibreTV-SourceList / TVBOX / 接口目录），
 * 差别只在入口：订阅从远端 URL 拉，这里从 FileReader 读到的文本解析。
 *
 * **点播与直播分开导入**：每个面板只吃自己那一半，文件里另一半会明确提示去对面面板，
 * 而不是静默丢弃——用户拿到的是一份完整源列表文件时，不该出现「导了一半」的困惑。
 */

export type SourceFileKind = 'vod' | 'live';

export interface ParsedSourceFile {
  /** 解析出的完整内容（两种源都可能非空） */
  payload: SourceListPayload;
  /** 与本面板类型一致的条目数 */
  ownCount: number;
  /** 另一种类型的条目数，用于提示「请到对面面板导入」 */
  otherCount: number;
}

/** 频道播放列表（m3u/txt）不是源地址列表，导入前就该拦下来并说清楚 */
const M3U_HEADER = /^#EXTM3U\b/i;

/** 直播源条目的地址必须是 m3u/m3u8/txt 列表，或至少是 http(s) 地址 */
function toLiveEntries(entries: unknown[]): Omit<LiveSourceConfig, 'key'>[] {
  const out: Omit<LiveSourceConfig, 'key'>[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    // 直播源地址保留尾部斜杠以外的原样（m3u 地址带查询参数很常见，不做裁剪）
    const url = normalizeUrl(item.url, false);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      name: optionalString(item.name) || hostnameOf(url),
      epg: normalizeUrl(item.epg, false),
    });
  }
  return out;
}

/**
 * 解析源文件文本。
 *
 * 直播面板对**裸数组**按直播源解释（`[{name, url, epg}]`）——同一个数组在两个面板
 * 里的含义本来就不同，靠面板区分比靠字段猜更可靠；对象形态仍走通用解析器。
 *
 * 解析失败一律抛出带原因的错误，由调用方 toast 给用户。
 */
export function parseSourceFile(text: string, kind: SourceFileKind): ParsedSourceFile {
  const raw = text.replace(/^\uFEFF/, '');
  if (!raw.trim()) throw new Error('文件是空的');

  if (M3U_HEADER.test(raw.trim())) {
    throw new Error(
      kind === 'live'
        ? '这是频道播放列表（M3U），不是直播源地址列表。请先把文件托管成 URL，再在「直播源」里添加该地址'
        : '这是频道播放列表（M3U），不是点播源列表。点播源需要 Apple CMS 采集站接口'
    );
  }

  const json = parseSubscriptionJson(raw);

  let payload: SourceListPayload;
  if (kind === 'live' && Array.isArray(json)) {
    payload = { sources: [], liveSources: toLiveEntries(json), stats: undefined };
  } else {
    payload = parseSubscriptionPayload(json);
  }

  const ownCount = kind === 'vod' ? payload.sources.length : payload.liveSources.length;
  const otherCount = kind === 'vod' ? payload.liveSources.length : payload.sources.length;

  if (ownCount === 0) {
    if (otherCount > 0) {
      const target = kind === 'vod' ? '直播源' : '点播源';
      throw new Error(
        `这个文件里只有 ${otherCount} 个${target}，请到「${target}」面板导入`
      );
    }
    throw new Error('文件里没有可导入的源');
  }

  return { payload, ownCount, otherCount };
}

/** 从解析结果里取出本面板该用的那一半，并统一成入库形态 */
export function pickSourcesFor(
  parsed: ParsedSourceFile,
  kind: SourceFileKind
): { vod: Omit<SourceConfig, 'key'>[]; live: Omit<LiveSourceConfig, 'key'>[] } {
  return kind === 'vod'
    ? { vod: parsed.payload.sources, live: [] }
    : { vod: [], live: parsed.payload.liveSources };
}
