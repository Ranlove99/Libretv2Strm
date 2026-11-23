import fs from 'node:fs';
import path from 'node:path';
import { resolveStrmBaseUrl } from './base-url';
import { fetchVodDetail, searchSourceVideos, type CmsSource } from './cms-catalog';
import { getStrmConfig } from './config';
import { pickVideo } from './cross-source';
import { planGeneration, writeGeneration } from './generator';
import { downloadPoster } from './poster';
import { recordSourceResult } from './source-stats';
import type { StrmFolderRefreshResult } from './types';

/**
 * 文件夹级「手动更新」：指定一个源，重新抓取该文件夹对应的影片并覆盖里面的 strm。
 *
 * 与生成任务的区别：生成任务从「源 + vodId」出发；这里从**磁盘上的文件夹**出发——
 * 用户看到某部剧失效了，直接在文件列表里点它，选一个还能用的源，就地更新。
 *
 * 关键取舍：
 * - 标题/年份从文件夹名反解（生成时的模板就是「{title} ({year})」），
 *   所以不需要任务记录也能用；任务记录早就被 100 条上限清掉时依然可救。
 * - 只在「新路径与旧路径一致」时清理多余的旧 .strm：源站标题变了会写到新目录，
 *   这时删旧文件属于误删，改为把新目录回给前端提示。
 * - 每次搜索 / 拉详情都回写源评分，跨源替代修复的候选排序因此越用越准。
 */

/** 季目录名：命中时标题要往上一级取（剧集模板是 剧名/Season N/…） */
const SEASON_DIR = /^(season\s*\d+|第\s*[0-9一二三四五六七八九十]+\s*季)$/i;
/** 生成模板的目录名：标题 + 可选年份括号 */
const TITLE_DIR = /^(.*?)\s*[（(]\s*(\d{4})?\s*[）)]$/;

export interface ParsedFolder {
  /** 反解出的影片标题（已去掉年份括号） */
  title: string;
  year?: string;
}

/**
 * 从文件夹路径反解影片标题与年份。
 * 支持 `电视剧/凡仙修仙传 (2020)`、`电影/流浪地球 (2019)/流浪地球 (2019)`、
 * 季目录 `电视剧/某剧 (2024)/Season 1`、以及没有年份的 `走马上任 ()`。
 */
export function parseFolderTitle(dir: string): ParsedFolder | undefined {
  const segments = dir
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  // 从末级往前找：跳过 Season 目录，取第一个「像片名」的段
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (SEASON_DIR.test(seg)) continue;
    const m = seg.match(TITLE_DIR);
    if (m) {
      const title = m[1].trim();
      if (title) return { title, year: m[2] || undefined };
      continue;
    }
    // 没有括号：整段当标题（自定义模板常见）
    return { title: seg, year: undefined };
  }
  return undefined;
}

export interface RefreshFolderInput {
  /** 相对输出目录的文件夹路径 */
  dir: string;
  sourceUrl: string;
  sourceName?: string;
  sourceKey?: string;
}

/** 收集目录下所有 .strm（相对 root，限深度 4，够覆盖 剧名/Season N/ 结构） */
async function collectStrm(dirAbs: string, rootAbs: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    const abs = path.join(dirAbs, d.name);
    if (d.isDirectory()) {
      out.push(...(await collectStrm(abs, rootAbs, depth + 1)));
    } else if (d.isFile() && d.name.toLowerCase().endsWith('.strm')) {
      out.push(path.relative(rootAbs, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

/** 防目录逃逸 */
function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('非法的目录路径');
  }
  return abs;
}

/**
 * 用指定源重新抓取文件夹对应的影片，覆盖其中的 strm。
 * 同步执行（一次搜索 + 一次详情 + 写盘），失败时返回可读原因而不是抛错。
 */
export async function refreshFolderFromSource(
  input: RefreshFolderInput
): Promise<StrmFolderRefreshResult> {
  const cfg = getStrmConfig();
  const root = path.resolve(cfg.outputDir);
  const rel = input.dir.replace(/^\/+/, '').replace(/\/+$/, '');
  const result: StrmFolderRefreshResult = { ok: false, dir: rel };

  if (!rel) return { ...result, error: '请选择要更新的文件夹' };
  if (!/^https?:\/\//i.test(input.sourceUrl || '')) {
    return { ...result, error: '请选择一个有效的采集源' };
  }
  try {
    const dirAbs = resolveInside(root, rel);
    const st = await fs.promises.stat(dirAbs).catch(() => null);
    if (!st || !st.isDirectory()) return { ...result, error: '文件夹不存在' };
  } catch (err) {
    return { ...result, error: err instanceof Error ? err.message : '非法的目录路径' };
  }

  const parsed = parseFolderTitle(rel);
  if (!parsed) return { ...result, error: '无法从文件夹名解析出片名' };

  const source: CmsSource = {
    key: input.sourceKey || input.sourceUrl,
    name: input.sourceName || input.sourceUrl,
    url: input.sourceUrl,
  };
  const started = Date.now();

  // 1) 搜索同名影片（年份一致优先）
  let videos;
  try {
    videos = await searchSourceVideos(source, parsed.title);
  } catch (err) {
    recordSourceResult({ url: source.url, name: source.name, ok: false });
    return {
      ...result,
      error: `搜索失败：${err instanceof Error ? err.message : '未知错误'}`,
    };
  }
  const video = pickVideo(videos, parsed.title, parsed.year);
  if (!video) {
    return {
      ...result,
      error: `该源没有找到「${parsed.title}」`,
      candidates: videos.slice(0, 8).map((v) => (v.year ? `${v.name} (${v.year})` : v.name)),
    };
  }

  // 2) 拉详情 → 计算路径计划
  let detail;
  try {
    detail = await fetchVodDetail(source, video.vodId);
  } catch (err) {
    recordSourceResult({ url: source.url, name: source.name, ok: false });
    return {
      ...result,
      error: `拉取详情失败：${err instanceof Error ? err.message : '未知错误'}`,
    };
  }
  if (detail.episodes.length === 0) {
    return { ...result, error: '该源这部片没有可用的播放地址' };
  }
  if (cfg.maxEpisodes > 0 && detail.episodes.length > cfg.maxEpisodes) {
    detail.episodes = detail.episodes.slice(0, cfg.maxEpisodes);
  }

  const plan = planGeneration(detail, cfg);
  const resolved = resolveStrmBaseUrl(cfg.publicBaseUrl);
  const baseUrl = resolved.baseUrl;

  // 3) 海报 + 写盘
  let poster: Buffer | undefined;
  if (cfg.downloadPoster && detail.pic) poster = await downloadPoster(detail.pic);
  const writtenFiles = await writeGeneration(plan, detail, cfg, cfg.outputDir, baseUrl, poster);
  const writtenStrm = writtenFiles.filter((f) => f.kind === 'strm').map((f) => f.file);

  recordSourceResult({ url: source.url, name: source.name, ok: true, ms: Date.now() - started });

  // 4) 清理旧 strm：仅当新路径与点击的文件夹一致时（否则会误删别的影片）
  let removed = 0;
  if (plan.dir === rel) {
    const existing = await collectStrm(resolveInside(root, rel), root);
    const keep = new Set(writtenStrm);
    for (const file of existing) {
      if (keep.has(file)) continue;
      try {
        await fs.promises.unlink(resolveInside(root, file));
        removed += 1;
      } catch {
        // 删不掉不影响更新结果
      }
    }
  }

  return {
    ok: true,
    dir: rel,
    matched: {
      vodId: video.vodId,
      title: detail.title || video.name,
      year: video.year,
      kind: plan.kind,
      episodes: plan.episodes.length,
    },
    targetDir: plan.dir,
    written: writtenStrm.length,
    removed,
  };
}
