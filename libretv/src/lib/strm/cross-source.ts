import { fetchVodDetail, searchSourceVideos, type CmsSource } from './cms-catalog';
import { rankedCandidates, recordSourceResult } from './source-stats';
import type { CatalogVideo, StrmSourceStatView } from './types';

/**
 * 跨源替代修复：原源拉不到详情时，改用评分更高的其他源找回同一部片。
 *
 * 原理：任务记录里除了源的接口地址，还存了影片标题（title / year）与集名 / 集序——
 * 这些字段跨源通用。候选源按评分降序逐个尝试：
 *   搜索标题 → 匹配影片（同名优先，年份一致加分）→ 拉详情 → 匹配同一集 → 返回新地址。
 * 每次尝试（无论成败）都回写源评分：搜不到片的源降分，成功救回的源加分。
 *
 * 与「结构修复」「原源深度修复」的关系：只在原源深度修复失败后才启用，
 * 能用原源修的永远优先用原源——同源分集序号与集名是精确对应的，跨源只是兜底。
 */

/** 单文件最多尝试的候选源数：再多就要拖慢整轮检查 */
export const MAX_CROSS_CANDIDATES = 4;

/** 标题归一化：去空白与常见标点，让「海贼王」和「海贼 王」能对上 */
function normalizeTitle(text: string): string {
  return text
    .replace(/[\s·・：:，,。.（）()【】\[\]「」"'’‘]+/g, '')
    .toLowerCase();
}

/** 年份提取：从「(2023)」「2023」等片段里拿四位数字 */
function yearOf(text?: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(/(19|20)\d{2}/);
  return m ? m[0] : undefined;
}

/**
 * 从搜索结果里挑出目标影片。
 * 优先级：标题完全一致且年份一致 > 标题完全一致 > 归一化后一致 > 单向包含。
 * 集数少的资源（如只有预告片）也可能同名，年份是用来区分重名片的关键。
 */
export function pickVideo(
  videos: CatalogVideo[],
  title: string,
  year?: string
): CatalogVideo | undefined {
  const target = normalizeTitle(title);
  if (!target) return undefined;
  const targetYear = yearOf(year);
  const byName = videos.filter((v) => {
    const name = normalizeTitle(v.name);
    return name === target || (name.length > 0 && (name.includes(target) || target.includes(name)));
  });
  if (byName.length === 0) return undefined;
  if (targetYear) {
    const sameYear = byName.find((v) => yearOf(v.year) === targetYear);
    if (sameYear) return sameYear;
  }
  return byName.find((v) => normalizeTitle(v.name) === target) ?? byName[0];
}

/**
 * 从详情的分集列表里找回原来的那一集。
 * 集名精确匹配最可靠；对不上时若集数足够则按序号取（同一部片集序通常稳定）。
 */
export function pickEpisode(
  episodes: { name: string; url: string }[],
  episodeName: string,
  episodeIndex: number
): { name: string; url: string } | undefined {
  const target = normalizeTitle(episodeName);
  if (target) {
    const byName = episodes.find((e) => normalizeTitle(e.name) === target);
    if (byName) return byName;
  }
  return episodes[episodeIndex];
}

export interface CrossRepairOrigin {
  sourceUrl: string;
  title: string;
  year?: string;
  episodeIndex: number;
  episodeName: string;
}

export interface CrossRepairHit {
  url: string;
  sourceName: string;
  sourceUrl: string;
  vodId: string;
  episodeName: string;
}

/** 候选注入接口：测试时替换 rankedCandidates 的返回 */
export interface CrossRepairDeps {
  candidates?: (excludeUrl: string, limit: number) => StrmSourceStatView[];
  search?: typeof searchSourceVideos;
  detail?: typeof fetchVodDetail;
  record?: typeof recordSourceResult;
  probe?: (url: string, signal?: AbortSignal) => Promise<void>;
}

/**
 * 播放地址预检：m3u8 要求内容含 #EXTM3U，mp4/ts 等直链 200 即可。
 * 与 verify.ts 的口径一致，但这里验证的是候选源给出的原始地址，
 * 不经过本站代理，也不需要 SSRF 预检（地址来自采集站响应）。
 */
export async function probeStreamUrl(url: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(8000);
  const res = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: '*/*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  const looksLikeM3u8 = /mpegurl|x-mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(url);
  if (looksLikeM3u8) {
    const text = await res.text();
    if (!text.includes('#EXTM3U')) throw new Error('播放列表无效');
    return;
  }
  await res.body?.cancel();
}

const defaultDeps: Required<Pick<CrossRepairDeps, 'candidates' | 'search' | 'detail' | 'record' | 'probe'>> = {
  candidates: rankedCandidates,
  search: searchSourceVideos,
  detail: fetchVodDetail,
  record: recordSourceResult,
  probe: probeStreamUrl,
};

/**
 * 在候选源里寻找同一集的替代地址。
 * 返回 null 表示所有候选都失败（评分已相应扣减）；抛错只可能是内部 bug。
 */
export async function findReplacementEpisode(
  origin: CrossRepairOrigin,
  signal: AbortSignal | undefined,
  deps: CrossRepairDeps = {}
): Promise<CrossRepairHit | null> {
  const d = { ...defaultDeps, ...deps };
  const startedAll = Date.now();
  const candidates = d.candidates(origin.sourceUrl, MAX_CROSS_CANDIDATES);

  for (const cand of candidates) {
    if (signal?.aborted) return null;
    const source: CmsSource = { key: cand.url, name: cand.name, url: cand.url };
    const started = Date.now();

    let videos: CatalogVideo[];
    try {
      videos = await d.search(source, origin.title, signal);
    } catch {
      // 暂停 / 取消不算源故障；单个候选失败也不终止，换下一个继续
      if (signal?.aborted) return null;
      d.record({ url: cand.url, name: cand.name, ok: false });
      continue;
    }

    const video = pickVideo(videos, origin.title, origin.year);
    if (!video) {
      // 源能访问但没有这部片：不算源故障（接口是通的），也不加分
      continue;
    }

    let episodes: { name: string; url: string }[];
    try {
      const detail = await d.detail(source, video.vodId, signal);
      episodes = detail.episodes;
    } catch {
      if (signal?.aborted) return null;
      d.record({ url: cand.url, name: cand.name, ok: false, ms: Date.now() - started });
      continue;
    }

    const ep = pickEpisode(episodes, origin.episodeName, origin.episodeIndex);
    if (!ep || !/^https?:\/\//.test(ep.url)) continue;

    // 流地址预检：写进 strm 前先确认真能拉到流，避免「修复成功」实际是死链
    try {
      await d.probe(ep.url, signal);
    } catch {
      if (signal?.aborted) return null;
      continue;
    }

    d.record({ url: cand.url, name: cand.name, ok: true, ms: Date.now() - startedAll });
    return {
      url: ep.url,
      sourceName: cand.name,
      sourceUrl: cand.url,
      vodId: video.vodId,
      episodeName: ep.name,
    };
  }
  return null;
}
