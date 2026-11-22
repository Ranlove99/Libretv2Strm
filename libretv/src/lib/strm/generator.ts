import fs from 'node:fs';
import path from 'node:path';
import { buildEpisodeNfo, buildMovieNfo, buildTvShowNfo } from './nfo';
import { parseSeasonEpisode, renderTemplate, sanitizeFileName, stripQualityTags } from './naming';
import { signStrmUrl } from './sign';
import type { StrmConfig, VodDetail } from './types';

/**
 * 文件生成器：把影片详情落成 .strm / .nfo / poster.jpg。
 * 路径计算（planGeneration）与写盘（writeGeneration）分离，便于单测。
 */

export interface GeneratedFile {
  /** 相对输出目录的路径 */
  file: string;
  kind: 'strm' | 'nfo' | 'poster';
}

export interface PlannedEpisode {
  name: string;
  /** 相对输出目录的 .strm 路径 */
  file: string;
  season: number;
  episode: number;
}

export interface GeneratePlan {
  /** 影片判定：movie=单集影片，tv=剧集 */
  kind: 'movie' | 'tv';
  /** 媒体目录（相对输出目录）：电影=影片目录，剧集=剧集顶层目录（放 tvshow.nfo/poster） */
  dir: string;
  episodes: PlannedEpisode[];
}

/** 是否按剧集处理：多集，或单集但显式带季信息（第N季 / Season N） */
function detectTv(parsed: { name: string; season: number; episode: number }[]): boolean {
  if (parsed.length > 1) return true;
  return parsed.some((p) => p.season > 1 || /[季部]|season/i.test(p.name));
}

/** 计算影片的目录结构与每集文件名（不写盘，任务与测试共用） */
export function planGeneration(vod: VodDetail, config: StrmConfig): GeneratePlan {
  const cleanTitle = sanitizeFileName(stripQualityTags(vod.title) || vod.title);
  const year = vod.year && /^\d{4}$/.test(vod.year) ? vod.year : undefined;

  const parsed = vod.episodes.map((ep, i) => {
    const se = parseSeasonEpisode(ep.name);
    return { name: ep.name, season: se?.season ?? 1, episode: se?.episode ?? 0, index: i };
  });

  const isTv = detectTv(parsed);
  const prefix = config.separateTv ? (isTv ? '电视剧/' : '电影/') : '';

  if (!isTv) {
    const rel = renderTemplate(config.movieTemplate, { title: cleanTitle, year }) + '.strm';
    const dir = path.posix.dirname(rel);
    return {
      kind: 'movie',
      dir: path.posix.join(prefix, dir),
      episodes: [{ name: vod.episodes[0]?.name ?? '正片', file: path.posix.join(prefix, rel), season: 1, episode: 1 }],
    };
  }

  const episodes: PlannedEpisode[] = parsed.map((p) => {
    const epNo = p.episode || p.index + 1;
    const rel = renderTemplate(config.tvTemplate, { title: cleanTitle, year, season: p.season, episode: epNo }) + '.strm';
    return { name: p.name, file: path.posix.join(prefix, rel), season: p.season, episode: epNo };
  });

  // 剧集顶层目录 = 首个分片目录的上级（模板通常为 剧名/Season N/剧名 S01E01.strm）
  // showDir 已含 separateTv 前缀（来自 episodes 路径），不再叠加
  const firstFileDir = path.posix.dirname(episodes[0].file);
  const showDir = path.posix.dirname(firstFileDir);
  return { kind: 'tv', dir: showDir, episodes };
}

/** 单集 strm 内容：direct=原始地址；proxy=经本站签名代理（publicBaseUrl 为空时退回直链） */
export function strmContent(url: string, config: StrmConfig, publicBaseUrl: string): string {
  if (config.urlMode === 'direct') return url;
  const base = (publicBaseUrl || '').replace(/\/+$/, '');
  if (!base) return url;
  return `${base}/api/strm/play?u=${encodeURIComponent(url)}&sig=${signStrmUrl(url)}`;
}

/** 防目录逃逸：解析后的绝对路径必须位于输出目录内 */
function guardRoot(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`非法输出路径: ${rel}`);
  }
  return abs;
}

/** 把计划落成磁盘文件，返回写入清单 */
export async function writeGeneration(
  plan: GeneratePlan,
  vod: VodDetail,
  config: StrmConfig,
  outputDir: string,
  publicBaseUrl: string,
  posterBuffer?: Buffer
): Promise<GeneratedFile[]> {
  const root = path.resolve(outputDir);
  const written: GeneratedFile[] = [];

  // 海报：电影目录 / 剧集顶层目录各一份
  if (config.downloadPoster && posterBuffer && posterBuffer.length > 0) {
    const rel = path.posix.join(plan.dir, 'poster.jpg');
    const abs = guardRoot(root, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, posterBuffer);
    written.push({ file: rel, kind: 'poster' });
  }

  if (plan.kind === 'movie') {
    const ep = plan.episodes[0];
    const src = vod.episodes[0];
    if (!src) throw new Error('影片无播放地址');
    const strmAbs = guardRoot(root, ep.file);
    await fs.promises.mkdir(path.dirname(strmAbs), { recursive: true });
    await fs.promises.writeFile(strmAbs, strmContent(src.url, config, publicBaseUrl), 'utf8');
    written.push({ file: ep.file, kind: 'strm' });
    if (config.generateNfo) {
      const rel = ep.file.replace(/\.strm$/, '.nfo');
      await fs.promises.writeFile(guardRoot(root, rel), buildMovieNfo(vod), 'utf8');
      written.push({ file: rel, kind: 'nfo' });
    }
    return written;
  }

  // 剧集：逐集 strm + nfo，tvshow.nfo 一份
  let wroteTvShow = false;
  plan.episodes.forEach((ep, i) => {
    const src = vod.episodes[i];
    if (!src) throw new Error(`第 ${i + 1} 集缺少播放地址`);
  });
  for (const [i, ep] of plan.episodes.entries()) {
    const src = vod.episodes[i];
    const strmAbs = guardRoot(root, ep.file);
    await fs.promises.mkdir(path.dirname(strmAbs), { recursive: true });
    await fs.promises.writeFile(strmAbs, strmContent(src.url, config, publicBaseUrl), 'utf8');
    written.push({ file: ep.file, kind: 'strm' });

    if (config.generateNfo) {
      const nfoRel = ep.file.replace(/\.strm$/, '.nfo');
      await fs.promises.writeFile(guardRoot(root, nfoRel), buildEpisodeNfo(vod, ep.season, ep.episode, ep.name), 'utf8');
      written.push({ file: nfoRel, kind: 'nfo' });

      if (!wroteTvShow) {
        const tvRel = path.posix.join(plan.dir, 'tvshow.nfo');
        await fs.promises.writeFile(guardRoot(root, tvRel), buildTvShowNfo(vod, ep.season, plan.episodes.length), 'utf8');
        written.push({ file: tvRel, kind: 'nfo' });
        wroteTvShow = true;
      }
    }
  }
  return written;
}
