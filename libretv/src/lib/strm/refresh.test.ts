import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StrmConfig, VodDetail } from './types';

/** 文件夹级手动更新：片名反解、跨源重新抓取、旧文件清理、失败分支 */

const fake = vi.hoisted(() => ({
  cfg: null as StrmConfig | null,
  dataDir: '',
  videos: [] as Array<{ vodId: string; name: string; year?: string }>,
  detail: null as VodDetail | null,
  searchError: '',
  detailError: '',
  recorded: [] as Array<{ url: string; ok: boolean }>,
}));

vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return {
    ...actual,
    getStrmConfig: () => fake.cfg as StrmConfig,
    strmDataRoot: () => fake.dataDir,
  };
});

vi.mock('./cms-catalog', () => ({
  searchSourceVideos: async () => {
    if (fake.searchError) throw new Error(fake.searchError);
    return fake.videos;
  },
  fetchVodDetail: async () => {
    if (fake.detailError) throw new Error(fake.detailError);
    return fake.detail;
  },
}));

vi.mock('./poster', () => ({ downloadPoster: async () => undefined }));

vi.mock('./source-stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source-stats')>();
  return {
    ...actual,
    recordSourceResult: (o: { url: string; ok: boolean }) => fake.recorded.push({ url: o.url, ok: o.ok }),
  };
});

import { parseFolderTitle, refreshFolderFromSource } from './refresh';

function cfg(outputDir: string): StrmConfig {
  return {
    outputDir,
    urlMode: 'direct',
    publicBaseUrl: '',
    movieTemplate: '{title} ({year})/{title} ({year})',
    tvTemplate: '{title} ({year})/Season {season}/{title} - S{season:02d}E{episode:02d}',
    generateNfo: false,
    downloadPoster: false,
    separateTv: true,
    concurrency: 2,
    maxEpisodes: 0,
    verifyAfterGenerate: false,
    autoCheck: false,
    autoCheckMode: 'daily',
    autoCheckAt: '03:00',
    autoCheckEveryDays: 1,
    autoCheckEveryHours: 6,
    autoFix: true,
    crossSourceRepair: true,
  };
}

function tvDetail(title: string, count: number, year = '2024'): VodDetail {
  return {
    title,
    year,
    episodes: Array.from({ length: count }, (_, i) => ({
      name: `第${i + 1}集`,
      url: `http://cdn.example/${i + 1}.m3u8`,
    })),
  };
}

const SOURCE = 'http://src.example/api.php/provide/vod';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'strm-refresh-'));
  fake.dataDir = root;
  fake.cfg = cfg(root);
  fake.videos = [];
  fake.detail = null;
  fake.searchError = '';
  fake.detailError = '';
  fake.recorded = [];
});

describe('parseFolderTitle', () => {
  it('剧集目录：标题 + 年份', () => {
    expect(parseFolderTitle('电视剧/凡仙修仙传 (2020)')).toEqual({ title: '凡仙修仙传', year: '2020' });
  });

  it('电影目录（同名嵌套）也能解析', () => {
    expect(parseFolderTitle('电影/流浪地球 (2019)/流浪地球 (2019)')).toEqual({
      title: '流浪地球',
      year: '2019',
    });
  });

  it('季目录回退到上一级', () => {
    expect(parseFolderTitle('电视剧/某剧 (2024)/Season 1')).toEqual({ title: '某剧', year: '2024' });
    expect(parseFolderTitle('电视剧/某剧 (2024)/第2季')).toEqual({ title: '某剧', year: '2024' });
  });

  it('空年份括号视为无年份', () => {
    expect(parseFolderTitle('电视剧/走马上任 ()')).toEqual({ title: '走马上任', year: undefined });
  });

  it('没有括号时整段当标题（自定义模板）', () => {
    expect(parseFolderTitle('电视剧/我的剧')).toEqual({ title: '我的剧', year: undefined });
  });

  it('空路径返回 undefined', () => {
    expect(parseFolderTitle('')).toBeUndefined();
    expect(parseFolderTitle('/')).toBeUndefined();
  });
});

describe('refreshFolderFromSource', () => {
  it('按片名在源里匹配并覆盖，清理多余旧集', async () => {
    const showDir = path.join(root, '电视剧/测试剧 (2024)/Season 1');
    fs.mkdirSync(showDir, { recursive: true });
    // 旧文件：3 集（其中 S01E03 在新源里不存在）
    for (const n of ['01', '02', '03']) {
      fs.writeFileSync(path.join(showDir, `测试剧 - S01E${n}.strm`), 'http://old.example/x.m3u8');
    }
    fs.writeFileSync(path.join(root, '电视剧/测试剧 (2024)/tvshow.nfo'), '<tvshow/>');

    fake.videos = [
      { vodId: 'v1', name: '测试剧', year: '2024' },
      { vodId: 'v2', name: '测试剧', year: '2018' },
    ];
    fake.detail = tvDetail('测试剧', 2);

    const r = await refreshFolderFromSource({
      dir: '电视剧/测试剧 (2024)',
      sourceUrl: SOURCE,
      sourceName: '测试源',
    });

    expect(r.ok).toBe(true);
    expect(r.matched).toMatchObject({ vodId: 'v1', kind: 'tv', episodes: 2, year: '2024' });
    expect(r.written).toBe(2);
    expect(r.removed).toBe(1); // S01E03 被清掉

    const files = fs.readdirSync(showDir).sort();
    expect(files).toEqual(['测试剧 - S01E01.strm', '测试剧 - S01E02.strm']);
    expect(fs.readFileSync(path.join(showDir, '测试剧 - S01E01.strm'), 'utf8')).toBe(
      'http://cdn.example/1.m3u8'
    );
    // tvshow.nfo 不在清理范围内
    expect(fs.existsSync(path.join(root, '电视剧/测试剧 (2024)/tvshow.nfo'))).toBe(true);
    expect(fake.recorded).toEqual([{ url: SOURCE, ok: true }]);
  });

  it('该源没有这部片：返回候选标题，不写盘', async () => {
    fs.mkdirSync(path.join(root, '电视剧/测试剧 (2024)'), { recursive: true });
    fake.videos = [
      { vodId: 'x', name: '别的剧', year: '2024' },
      { vodId: 'y', name: '另一个', year: '2023' },
    ];

    const r = await refreshFolderFromSource({ dir: '电视剧/测试剧 (2024)', sourceUrl: SOURCE });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有找到');
    expect(r.candidates).toEqual(['别的剧 (2024)', '另一个 (2023)']);
    expect(fs.readdirSync(path.join(root, '电视剧/测试剧 (2024)'))).toHaveLength(0);
  });

  it('搜索失败：记一次源失败并返回原因', async () => {
    fs.mkdirSync(path.join(root, '电视剧/测试剧 (2024)'), { recursive: true });
    fake.searchError = 'HTTP 502';

    const r = await refreshFolderFromSource({
      dir: '电视剧/测试剧 (2024)',
      sourceUrl: SOURCE,
      sourceName: '挂了的源',
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('搜索失败');
    expect(fake.recorded).toEqual([{ url: SOURCE, ok: false }]);
  });

  it('详情没有播放地址：不写盘', async () => {
    fs.mkdirSync(path.join(root, '电视剧/测试剧 (2024)'), { recursive: true });
    fake.videos = [{ vodId: 'v1', name: '测试剧', year: '2024' }];
    fake.detail = tvDetail('测试剧', 0);

    const r = await refreshFolderFromSource({ dir: '电视剧/测试剧 (2024)', sourceUrl: SOURCE });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('播放地址');
  });

  it('源站标题不一致：写到新目录且不清理旧目录', async () => {
    const oldDir = path.join(root, '电视剧/旧名字 (2024)');
    fs.mkdirSync(path.join(oldDir, 'Season 1'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'Season 1/旧名字 - S01E01.strm'), 'http://old/x.m3u8');

    // 搜索结果是「旧名字 之 新名字」（宽松匹配能对上），但详情标题是「新名字」
    fake.videos = [{ vodId: 'v1', name: '旧名字 之 新名字', year: '2024' }];
    fake.detail = tvDetail('新名字', 2); // 两集才判为剧集，目录落在 电视剧/

    const r = await refreshFolderFromSource({ dir: '电视剧/旧名字 (2024)', sourceUrl: SOURCE });

    expect(r.ok).toBe(true);
    expect(r.targetDir).toBe('电视剧/新名字 (2024)');
    expect(r.removed).toBe(0);
    // 旧文件保留，新目录已生成
    expect(fs.existsSync(path.join(oldDir, 'Season 1/旧名字 - S01E01.strm'))).toBe(true);
    expect(
      fs.existsSync(path.join(root, '电视剧/新名字 (2024)/Season 1/新名字 - S01E01.strm'))
    ).toBe(true);
  });

  it('目录不存在 / 越界 / 空 dir 都给出可读错误', async () => {
    expect((await refreshFolderFromSource({ dir: '', sourceUrl: SOURCE })).error).toContain('选择');
    expect(
      (await refreshFolderFromSource({ dir: '不存在的目录 (2024)', sourceUrl: SOURCE })).error
    ).toContain('不存在');
    expect(
      (await refreshFolderFromSource({ dir: '../etc', sourceUrl: SOURCE })).error
    ).toMatch(/非法|不存在/);
    expect(
      (await refreshFolderFromSource({ dir: '电视剧/测试剧 (2024)', sourceUrl: 'ftp://x' })).error
    ).toContain('采集源');
  });
});
