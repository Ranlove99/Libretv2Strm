import { cmsRequestHeaders } from '@/lib/cms-parser';
import { fetchUpstream } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { CatalogClass, CatalogVideo, VodDetail } from './types';

/**
 * 采集站（Apple CMS）目录浏览与详情拉取。
 * 与 /api/search、/api/detail 保持同一套上游约定，但额外保留分集名称
 * （strm 需要「第1集」文本来判定季/集与生成 NFO）。
 */

export interface CmsSource {
  key: string;
  name: string;
  url: string;
  detail?: string;
}

/** 详情页根地址：显式 detail 优先，否则用接口 origin 推导 */
function detailRootOf(source: CmsSource): string {
  return (source.detail || new URL(source.url).origin).replace(/\/+$/, '');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * 从 vod_play_url 提取「分集名 + 地址」对。
 * 格式：源1$$$源2，每组内 集1$URL1#集2$URL2。
 * 与播放器一致：优先取含 m3u8 直链的线路，均无则回退第一条。
 */
export function extractEpisodePairs(playUrl: string): { name: string; url: string }[] {
  if (!playUrl) return [];
  const groups = playUrl
    .split('$$$')
    .map((group) =>
      group
        .split('#')
        .map((ep) => {
          const idx = ep.lastIndexOf('$');
          if (idx <= 0) return null;
          const name = ep.slice(0, idx).trim();
          const url = ep.slice(idx + 1).trim();
          if (!/^https?:\/\//.test(url)) return null;
          return { name: name || '正片', url };
        })
        .filter((x): x is { name: string; url: string } => x !== null)
    )
    .filter((eps) => eps.length > 0);
  if (groups.length === 0) return [];
  return groups.find((eps) => eps.some((e) => e.url.includes('.m3u8'))) ?? groups[0];
}

/** 列表接口单条 → 统一视频条目 */
function toCatalogVideo(item: unknown): CatalogVideo | null {
  const vod = item as Record<string, unknown>;
  const vodId = String(vod.vod_id ?? '').trim();
  const name = String(vod.vod_name ?? '').trim();
  if (!vodId || !name) return null;
  return {
    vodId,
    name,
    pic: str(vod.vod_pic),
    typeName: str(vod.type_name),
    year: str(vod.vod_year),
    area: str(vod.vod_area),
    remarks: str(vod.vod_remarks),
  };
}

/** 分类树 + 最新列表：GET {base}?ac=videolist（部分源根路径直接返回 class + list） */
export async function fetchCatalogHome(
  source: CmsSource
): Promise<{ classes: CatalogClass[]; videos: CatalogVideo[] }> {
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) throw new Error(verdict.reason);
  const base = source.url.replace(/\/+$/, '');
  const res = await fetchUpstream(`${base}?ac=videolist`, {
    timeoutMs: 10000,
    headers: cmsRequestHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { class?: unknown; list?: unknown };
  const classes: CatalogClass[] = Array.isArray(data.class)
    ? data.class
        .map((c) => {
          const item = c as Record<string, unknown>;
          const id = String(item.type_id ?? '').trim();
          const name = String(item.type_name ?? '').trim();
          return id ? { id, name: name || id } : null;
        })
        .filter((x): x is CatalogClass => x !== null)
    : [];
  const videos = Array.isArray(data.list)
    ? data.list
        .map(toCatalogVideo)
        .filter((x): x is CatalogVideo => x !== null)
    : [];
  return { classes, videos };
}

/** 分类分页列表：GET {base}?ac=videolist&t={tid}&pg={pg} */
export async function fetchCatalogList(
  source: CmsSource,
  typeId: string,
  page: number
): Promise<{ videos: CatalogVideo[]; page: number; pagecount: number; total: number }> {
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) throw new Error(verdict.reason);
  const base = source.url.replace(/\/+$/, '');
  const res = await fetchUpstream(
    `${base}?ac=videolist&t=${encodeURIComponent(typeId)}&pg=${encodeURIComponent(String(page))}`,
    { timeoutMs: 10000, headers: cmsRequestHeaders() }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    list?: unknown;
    page?: unknown;
    pagecount?: unknown;
    total?: unknown;
  };
  const videos = Array.isArray(data.list)
    ? data.list
        .map(toCatalogVideo)
        .filter((x): x is CatalogVideo => x !== null)
    : [];
  const num = (v: unknown, d: number) => {
    const n = Number.parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    videos,
    page: num(data.page, page),
    pagecount: num(data.pagecount, 1),
    total: num(data.total, videos.length),
  };
}

/**
 * 影片详情：先走列表接口 ?ac=videolist&ids=，
 * 无播放地址时降级详情页 HTML 正则提取 m3u8（与 /api/detail 行为一致）。
 */
export async function fetchVodDetail(source: CmsSource, id: string, signal?: AbortSignal): Promise<VodDetail> {
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) throw new Error(verdict.reason);
  const base = source.url.replace(/\/+$/, '');
  const res = await fetchUpstream(`${base}?ac=videolist&ids=${encodeURIComponent(id)}`, {
    timeoutMs: 10000,
    headers: cmsRequestHeaders(),
    signal,
  });
  if (res.ok) {
    const data = (await res.json()) as { list?: Record<string, unknown>[] };
    const vod = Array.isArray(data.list) ? data.list[0] : undefined;
    if (vod) {
      const episodes = extractEpisodePairs(String(vod.vod_play_url ?? ''));
      if (episodes.length > 0) {
        return {
          title: str(vod.vod_name) || '未知影片',
          year: str(vod.vod_year),
          typeName: str(vod.type_name),
          area: str(vod.vod_area),
          director: str(vod.vod_director),
          actor: str(vod.vod_actor),
          content: str(vod.vod_content),
          pic: str(vod.vod_pic),
          remarks: str(vod.vod_remarks),
          episodes,
        };
      }
    }
  }

  // 降级：详情页 HTML 提取（仅 m3u8 链接，分集名退化为序号）
  const root = detailRootOf(source);
  if (!/^https?:\/\//.test(root)) throw new Error('未找到播放资源');
  const rootVerdict = await checkUpstreamAllowed(root);
  if (!rootVerdict.ok) throw new Error(rootVerdict.reason);
  const detailRes = await fetchUpstream(`${root}/index.php/vod/detail/id/${encodeURIComponent(id)}.html`, {
    timeoutMs: 10000,
    headers: { 'User-Agent': cmsRequestHeaders()['User-Agent'] },
    signal,
  });
  if (!detailRes.ok) throw new Error('未找到播放资源');
  const html = await detailRes.text();
  const matches = html.match(/\$https?:\/\/[^"'\s]+?\.m3u8/g) || [];
  const episodes = matches
    .map((m, i) => ({ name: `第${i + 1}集`, url: m.replace(/^\$/, '') }))
    .filter((e) => e.url.length > 0);
  if (episodes.length === 0) throw new Error('未找到播放资源');
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  return {
    title: titleMatch ? titleMatch[1].trim() : '未知影片',
    episodes,
  };
}
