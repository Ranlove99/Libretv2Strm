import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAndRepairStrm, buildOriginIndex } from './repair';
import type { StrmConfig, StrmSourceStatView, StrmTask } from './types';

/** 深度修复的跨源替代：原源拉详情失败 → 评分最高的候选源搜索同名影片救回 */

const fake = vi.hoisted(() => ({
  /** 原源详情是否失败 */
  originDown: true,
  /** 搜索 / 详情接口返回的分集 */
  episodes: [
    { name: '第1集', url: 'http://cdn.example/1.m3u8' },
    { name: '第2集', url: 'http://cdn.example/2.m3u8' },
    { name: '第3集', url: 'http://cdn.example/3.m3u8' },
  ],
  candidates: [] as StrmSourceStatView[],
  recorded: [] as Array<{ url: string; name?: string; ok: boolean }>,
}));

vi.mock('./cms-catalog', () => ({
  fetchVodDetail: async (source: { url: string }) => {
    if (source.url === 'http://origin.example/vod') {
      if (fake.originDown) throw new Error('fetch failed');
      return { title: '斗罗大陆', episodes: fake.episodes };
    }
    return { title: '斗罗大陆', episodes: fake.episodes };
  },
  searchSourceVideos: async () => [{ vodId: 'v1', name: '斗罗大陆', year: '2023' }],
}));

vi.mock('./source-stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source-stats')>();
  return {
    ...actual,
    rankedCandidates: () => fake.candidates,
    recordSourceResult: (o: { url: string; name?: string; ok: boolean }) => {
      fake.recorded.push(o);
    },
  };
});

beforeAll(() => {
  process.env.PROXY_SECRET = 'repair-cross-test-secret';
  // 跨源候选的流地址预检（probeStreamUrl）会真实 fetch：测试里统一返回有效 m3u8
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nstream\n', {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      })
    )
  );
});

function cfg(outputDir: string): StrmConfig {
  return {
    outputDir,
    urlMode: 'proxy',
    publicBaseUrl: 'http://192.168.1.10:8099',
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

function taskWithFile(file: string): StrmTask {
  return {
    id: 't1',
    title: 't1',
    status: 'done',
    total: 1,
    done: 1,
    failed: 0,
    createdAt: 0,
    items: [
      {
        sourceKey: 'origin',
        sourceName: '原源',
        sourceUrl: 'http://origin.example/vod',
        vodId: '42',
        title: '斗罗大陆',
        year: '2023',
        status: 'done',
        episodes: [
          { name: '第1集' },
          { name: '第2集' },
          { name: '第3集', file },
        ],
      },
    ],
  };
}

/** 中继域名直链：结构修复救不了（unfixable），必然走深度修复 */
function deadStrm(): string {
  return 'https://abc.fnos.net/v/index.m3u8';
}

function candidate(name: string, url: string): StrmSourceStatView {
  return { url, name, score: 80, ok: 3, fail: 0, samples: 3, successRate: 100, failStreak: 0 };
}

function setup(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strm-cross-'));
  fs.writeFileSync(path.join(dir, 'a.strm'), deadStrm());
  fake.recorded = [];
  return dir;
}

describe('checkAndRepairStrm 跨源替代', () => {
  it('原源失败 → 候选源救回，写明 deepSource', async () => {
    const dir = setup();
    fake.originDown = true;
    fake.candidates = [candidate('高评分源', 'http://backup.example/vod')];

    const result = await checkAndRepairStrm(cfg(dir), [taskWithFile('a.strm')], {
      repair: true,
      deep: true,
      crossSource: true,
      onSource: (info) => fake.recorded.push(info),
    });

    expect(result.deepFixed).toBe(1);
    expect(result.unfixable).toBe(0);
    const detail = result.details[0];
    expect(detail?.deepFixed).toBe(true);
    expect(detail?.deepSource).toBe('高评分源');
    // 集名「第3集」精确匹配到候选源的第 3 集
    expect(detail?.reason).toBeUndefined();

    const content = fs.readFileSync(path.join(dir, 'a.strm'), 'utf8');
    expect(content).toContain('/api/strm/play?u=');
    expect(decodeURIComponent(new URL(content).searchParams.get('u') ?? '')).toBe(
      'http://cdn.example/3.m3u8'
    );

    // 评分：原源记失败，候选源记成功
    expect(fake.recorded).toEqual([
      { url: 'http://origin.example/vod', name: '原源', ok: false },
      { url: 'http://backup.example/vod', name: '高评分源', ok: true, ms: expect.any(Number) },
    ]);
  });

  it('关闭跨源替代：保持旧行为，原源失败即不可修', async () => {
    const dir = setup();
    fake.originDown = true;
    fake.candidates = [candidate('高评分源', 'http://backup.example/vod')];

    const result = await checkAndRepairStrm(cfg(dir), [taskWithFile('a.strm')], {
      repair: true,
      deep: true,
      crossSource: false,
      onSource: (info) => fake.recorded.push(info),
    });

    expect(result.deepFixed).toBe(0);
    expect(result.unfixable).toBe(1);
    expect(result.details[0]?.reason).toContain('原源失败');
    expect(fake.recorded).toEqual([
      { url: 'http://origin.example/vod', name: '原源', ok: false },
    ]);
  });

  it('原源正常：直接用原源修，不碰候选源', async () => {
    const dir = setup();
    fake.originDown = false;
    fake.candidates = [candidate('高评分源', 'http://backup.example/vod')];

    const result = await checkAndRepairStrm(cfg(dir), [taskWithFile('a.strm')], {
      repair: true,
      deep: true,
      crossSource: true,
      onSource: (info) => fake.recorded.push(info),
    });

    expect(result.deepFixed).toBe(1);
    expect(result.details[0]?.deepSource).toBe('原源');
    expect(fake.recorded).toEqual([
      { url: 'http://origin.example/vod', name: '原源', ok: true, ms: expect.any(Number) },
    ]);
  });

  it('候选源也找不到：保留失败原因，两个源各记一次失败', async () => {
    const dir = setup();
    fake.originDown = true;
    fake.candidates = [];
    const tasks = [taskWithFile('a.strm')];
    const index = buildOriginIndex(tasks);

    const result = await checkAndRepairStrm(cfg(dir), tasks, {
      repair: true,
      deep: true,
      crossSource: true,
      onSource: (info) => fake.recorded.push(info),
    });

    expect(result.deepFixed).toBe(0);
    expect(result.unfixable).toBe(1);
    expect(result.details[0]?.reason).toContain('候选源也未能替代');
    expect(index.get('a.strm')?.title).toBe('斗罗大陆');
    expect(fake.recorded).toEqual([
      { url: 'http://origin.example/vod', name: '原源', ok: false },
    ]);
  });
});
