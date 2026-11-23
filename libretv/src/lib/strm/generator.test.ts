import { describe, expect, it } from 'vitest';
import { planGeneration, strmContent } from './generator';
import type { StrmConfig, VodDetail } from './types';

function config(overrides: Partial<StrmConfig> = {}): StrmConfig {
  return {
    outputDir: '/data/strm',
    urlMode: 'proxy',
    publicBaseUrl: '',
    movieTemplate: '{title} ({year})/{title} ({year})',
    tvTemplate: '{title} ({year})/Season {season}/{title} - S{season:02d}E{episode:02d}',
    generateNfo: true,
    downloadPoster: true,
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
    ...overrides,
  };
}

function vod(overrides: Partial<VodDetail> = {}): VodDetail {
  return {
    title: '斗罗大陆',
    year: '2021',
    typeName: '动漫',
    episodes: [{ name: '第1集', url: 'https://example.com/1.m3u8' }],
    ...overrides,
  };
}

describe('planGeneration - 电影', () => {
  it('单集无集数信息按电影处理', () => {
    const plan = planGeneration(vod(), config());
    expect(plan.kind).toBe('movie');
    expect(plan.dir).toBe('电影/斗罗大陆 (2021)');
    expect(plan.episodes).toHaveLength(1);
    expect(plan.episodes[0].file).toBe('电影/斗罗大陆 (2021)/斗罗大陆 (2021).strm');
  });

  it('separateTv=false 时无顶层分类目录', () => {
    const plan = planGeneration(vod(), config({ separateTv: false }));
    expect(plan.dir).toBe('斗罗大陆 (2021)');
  });

  it('标题带画质标签时清洗', () => {
    const plan = planGeneration(vod({ title: '斗罗大陆 HD' }), config({ separateTv: false }));
    expect(plan.dir).toBe('斗罗大陆 (2021)');
  });
});

describe('planGeneration - 剧集', () => {
  const tvVod = vod({
    episodes: [
      { name: '第1集', url: 'https://example.com/1.m3u8' },
      { name: '第2集', url: 'https://example.com/2.m3u8' },
      { name: '第10集', url: 'https://example.com/10.m3u8' },
    ],
  });

  it('多集按剧集处理并补零编号', () => {
    const plan = planGeneration(tvVod, config());
    expect(plan.kind).toBe('tv');
    expect(plan.episodes.map((e) => e.file)).toEqual([
      '电视剧/斗罗大陆 (2021)/Season 1/斗罗大陆 - S01E01.strm',
      '电视剧/斗罗大陆 (2021)/Season 1/斗罗大陆 - S01E02.strm',
      '电视剧/斗罗大陆 (2021)/Season 1/斗罗大陆 - S01E10.strm',
    ]);
    // tvshow.nfo 所在目录 = 剧集顶层目录
    expect(plan.dir).toBe('电视剧/斗罗大陆 (2021)');
  });

  it('多季分目录', () => {
    const plan = planGeneration(
      vod({
        episodes: [
          { name: '第1季第1集', url: 'https://example.com/1.m3u8' },
          { name: '第2季第1集', url: 'https://example.com/2.m3u8' },
        ],
      }),
      config()
    );
    expect(plan.episodes[0].file).toContain('Season 1/');
    expect(plan.episodes[1].file).toContain('Season 2/');
  });

  it('剧集模板不含目录分隔时所有文件落同一级', () => {
    const plan = planGeneration(tvVod, config({ tvTemplate: '{title} S{season:02d}E{episode:02d}', separateTv: false }));
    expect(plan.episodes[0].file).toBe('斗罗大陆 S01E01.strm');
    expect(plan.dir).toBe('.');
  });
});

describe('strmContent', () => {
  const url = 'https://example.com/1.m3u8';
  it('direct 模式写原始地址', () => {
    expect(strmContent(url, config({ urlMode: 'direct' }), 'http://nas:8080')).toBe(url);
  });
  it('proxy 模式写签名代理地址', () => {
    const out = strmContent(url, config({ urlMode: 'proxy' }), 'http://nas:8080');
    expect(out).toMatch(/^http:\/\/nas:8080\/api\/strm\/play\?u=/);
    expect(out).toContain('&sig=');
    expect(out).toContain(encodeURIComponent(url));
  });
  it('proxy 模式无外部地址时退回直链', () => {
    expect(strmContent(url, config({ urlMode: 'proxy' }), '')).toBe(url);
  });
});
