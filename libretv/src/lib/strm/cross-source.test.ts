import { describe, expect, it, vi } from 'vitest';

/** 跨源替代修复：影片匹配、集匹配、候选遍历与评分回写 */

import {
  findReplacementEpisode,
  pickEpisode,
  pickVideo,
  probeStreamUrl,
  type CrossRepairDeps,
} from './cross-source';
import type { StrmSourceStatView } from './types';

function cand(name: string, url: string, score = 60): StrmSourceStatView {
  return {
    url,
    name,
    score,
    ok: 1,
    fail: 0,
    samples: 1,
    successRate: 100,
    failStreak: 0,
  };
}

const ORIGIN = {
  sourceUrl: 'http://origin.com/vod',
  title: '斗罗大陆',
  year: '2023',
  episodeIndex: 2,
  episodeName: '第3集',
};

function deps(overrides: Partial<CrossRepairDeps> = {}): CrossRepairDeps & {
  recorded: Array<{ url: string; ok: boolean }>;
} {
  const recorded: Array<{ url: string; ok: boolean }> = [];
  return {
    recorded,
    candidates: () => [],
    search: async () => [],
    detail: async () => ({ title: '', episodes: [] }),
    record: (o) => recorded.push({ url: o.url, ok: o.ok }),
    probe: async () => undefined,
    ...overrides,
  };
}

describe('pickVideo', () => {
  const videos = [
    { vodId: '1', name: '斗罗大陆', year: '2023' },
    { vodId: '2', name: '斗罗大陆', year: '2018' },
    { vodId: '3', name: '斗罗大陆之逆转时空', year: '2024' },
    { vodId: '4', name: '海贼王', year: '1999' },
  ];

  it('同名优先取年份一致的', () => {
    expect(pickVideo(videos, '斗罗大陆', '2023')?.vodId).toBe('1');
    expect(pickVideo(videos, '斗罗大陆', '2018')?.vodId).toBe('2');
  });

  it('无年份信息时取完全同名的第一个', () => {
    expect(pickVideo(videos, '斗罗大陆')?.vodId).toBe('1');
  });

  it('标题带空格/标点也能对上', () => {
    expect(pickVideo(videos, '斗罗 大陆（2023）', '2023')?.vodId).toBe('1');
  });

  it('完全同名缺失时接受单向包含', () => {
    expect(pickVideo(videos, '海贼王 特别篇')?.vodId).toBe('4');
  });

  it('没有匹配返回 undefined', () => {
    expect(pickVideo(videos, '三体')).toBeUndefined();
    expect(pickVideo(videos, '')).toBeUndefined();
  });
});

describe('pickEpisode', () => {
  const episodes = [
    { name: '第1集', url: 'http://x/1.m3u8' },
    { name: '第2集', url: 'http://x/2.m3u8' },
    { name: '第3集', url: 'http://x/3.m3u8' },
  ];

  it('集名精确匹配优先', () => {
    expect(pickEpisode(episodes, '第3集', 0)?.url).toBe('http://x/3.m3u8');
  });

  it('集名对不上时按序号取', () => {
    expect(pickEpisode(episodes, 'EP03', 2)?.url).toBe('http://x/3.m3u8');
  });

  it('序号越界返回 undefined', () => {
    expect(pickEpisode(episodes, '不存在', 9)).toBeUndefined();
  });
});

describe('probeStreamUrl', () => {
  it('非 m3u8 的 200 响应视为可用', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('', { status: 200, headers: { 'content-type': 'video/mp4' } })
      );
    await expect(probeStreamUrl('http://x/v.mp4')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://x/v.mp4');
    fetchMock.mockRestore();
  });

  it('m3u8 内容缺少 #EXTM3U 视为无效', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>err</html>', { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
    );
    await expect(probeStreamUrl('http://x/v.m3u8')).rejects.toThrow('播放列表无效');
    vi.restoreAllMocks();
  });

  it('HTTP 非 200 抛错', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
    await expect(probeStreamUrl('http://x/v.m3u8')).rejects.toThrow('HTTP 403');
    vi.restoreAllMocks();
  });
});

describe('findReplacementEpisode', () => {
  const EPISODES = [
    { name: '第1集', url: 'http://cdn/1.m3u8' },
    { name: '第2集', url: 'http://cdn/2.m3u8' },
    { name: '第3集', url: 'http://cdn/3.m3u8' },
  ];

  it('第一个候选成功：返回该集地址并记一次成功', async () => {
    const d = deps({
      candidates: () => [cand('候选A', 'http://a.com/vod')],
      search: async () => [{ vodId: 'v1', name: '斗罗大陆', year: '2023' }],
      detail: async () => ({ title: '斗罗大陆', episodes: EPISODES }),
    });
    const hit = await findReplacementEpisode(ORIGIN, undefined, d);
    expect(hit).not.toBeNull();
    expect(hit?.url).toBe('http://cdn/3.m3u8');
    expect(hit?.sourceName).toBe('候选A');
    expect(d.recorded).toEqual([{ url: 'http://a.com/vod', ok: true }]);
  });

  it('集名对不上时按序号取同一集', async () => {
    const d = deps({
      candidates: () => [cand('候选A', 'http://a.com/vod')],
      search: async () => [{ vodId: 'v1', name: '斗罗大陆', year: '2023' }],
      detail: async () => ({ title: '斗罗大陆', episodes: EPISODES.map((e, i) => ({ ...e, name: `EP0${i + 1}` })) }),
    });
    const hit = await findReplacementEpisode(ORIGIN, undefined, d);
    expect(hit?.url).toBe('http://cdn/3.m3u8');
  });

  it('搜索失败记一次失败后换下一个候选', async () => {
    const d = deps({
      candidates: () => [cand('候选A', 'http://a.com/vod'), cand('候选B', 'http://b.com/vod')],
      search: async (source) =>
        source.url === 'http://a.com/vod' ? Promise.reject(new Error('HTTP 502')) : [{ vodId: 'v1', name: '斗罗大陆' }],
      detail: async () => ({ title: '斗罗大陆', episodes: EPISODES }),
    });
    const hit = await findReplacementEpisode(ORIGIN, undefined, d);
    expect(hit?.sourceName).toBe('候选B');
    expect(d.recorded).toEqual([{ url: 'http://a.com/vod', ok: false }, { url: 'http://b.com/vod', ok: true }]);
  });

  it('源能访问但没有这部片：不记失败也不记成功，继续换源', async () => {
    const d = deps({
      candidates: () => [cand('候选A', 'http://a.com/vod'), cand('候选B', 'http://b.com/vod')],
      search: async (source) =>
        source.url === 'http://b.com/vod' ? [{ vodId: 'v1', name: '斗罗大陆' }] : [{ vodId: 'other', name: '别的片子' }],
      detail: async () => ({ title: '斗罗大陆', episodes: EPISODES }),
    });
    const hit = await findReplacementEpisode(ORIGIN, undefined, d);
    expect(hit?.sourceName).toBe('候选B');
    expect(d.recorded).toEqual([{ url: 'http://b.com/vod', ok: true }]);
  });

  it('流地址预检失败视为无效，继续换源', async () => {
    let probeCalls = 0;
    const d = deps({
      candidates: () => [cand('候选A', 'http://a.com/vod'), cand('候选B', 'http://b.com/vod')],
      search: async () => [{ vodId: 'v1', name: '斗罗大陆' }],
      detail: async () => ({ title: '斗罗大陆', episodes: EPISODES }),
      probe: async () => {
        probeCalls += 1;
        // 只有第一个候选的流地址失效（地址相同，按调用次序区分）
        if (probeCalls === 1) throw new Error('HTTP 403');
      },
    });
    const hit = await findReplacementEpisode(ORIGIN, undefined, d);
    expect(hit?.sourceName).toBe('候选B');
    expect(probeCalls).toBe(2);
    expect(d.recorded).toEqual([{ url: 'http://b.com/vod', ok: true }]);
  });

  it('全部候选失败返回 null', async () => {
    const d = deps({
      candidates: () => [cand('A', 'http://a.com/vod'), cand('B', 'http://b.com/vod')],
      search: async () => Promise.reject(new Error('HTTP 502')),
    });
    const hit = await findReplacementEpisode(ORIGIN, undefined, d);
    expect(hit).toBeNull();
    expect(d.recorded).toHaveLength(2);
  });

  it('没有候选源直接返回 null 且不联网', async () => {
    const search = vi.fn();
    const d = deps({ candidates: () => [], search });
    expect(await findReplacementEpisode(ORIGIN, undefined, d)).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it('暂停 / 取消后立刻停止且不计失败', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const d = deps({
      candidates: () => [cand('A', 'http://a.com/vod')],
      search: async () => Promise.reject(new Error('The operation was aborted')),
    });
    expect(await findReplacementEpisode(ORIGIN, ctrl.signal, d)).toBeNull();
    expect(d.recorded).toHaveLength(0);
  });

  it('候选数上限由调用方传入的 rankedCandidates 决定，这里验证逐个尝试顺序', async () => {
    const order: string[] = [];
    const d = deps({
      candidates: () => [cand('A', 'http://a.com/vod'), cand('B', 'http://b.com/vod'), cand('C', 'http://c.com/vod')],
      search: async (source) => {
        order.push(source.url);
        if (source.url === 'http://c.com/vod') return [{ vodId: 'v1', name: '斗罗大陆' }];
        throw new Error('HTTP 502');
      },
      detail: async () => ({ title: '斗罗大陆', episodes: EPISODES }),
    });
    const hit = await findReplacementEpisode(ORIGIN, undefined, d);
    expect(order).toEqual(['http://a.com/vod', 'http://b.com/vod', 'http://c.com/vod']);
    expect(hit?.sourceName).toBe('C');
  });
});
