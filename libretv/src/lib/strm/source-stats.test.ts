import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 源注册表与评分：登记、记分、评分公式、落盘恢复、候选排序 */

const fake = vi.hoisted(() => ({ dataDir: '' }));

vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return {
    ...actual,
    strmDataRoot: () => fake.dataDir,
  };
});

import {
  NEUTRAL_SCORE,
  __resetStrmSourcesForTest,
  flushSources,
  rankedCandidates,
  recordSourceResult,
  registerSources,
  scoreOf,
  sourceKeyOf,
  sourceNameOf,
  sourceViews,
} from './source-stats';

describe('sourceKeyOf', () => {
  it('trim 并去掉尾斜杠，同一地址归为同一个键', () => {
    expect(sourceKeyOf(' http://a.com/api.php/provide/vod/ ')).toBe('http://a.com/api.php/provide/vod');
    expect(sourceKeyOf('http://a.com/api.php/provide/vod')).toBe(sourceKeyOf('http://a.com/api.php/provide/vod/'));
  });
});

describe('scoreOf', () => {
  it('没有样本时给中性分', () => {
    expect(scoreOf({ ok: 0, fail: 0, okMsSum: 0, failStreak: 0 })).toBe(NEUTRAL_SCORE);
  });

  it('全成功且响应快 → 高分', () => {
    const s = scoreOf({ ok: 20, fail: 0, okMsSum: 20 * 500, failStreak: 0 });
    expect(s).toBeGreaterThanOrEqual(80);
  });

  it('全失败 → 0 分（扣到下限）', () => {
    expect(scoreOf({ ok: 0, fail: 10, okMsSum: 0, failStreak: 10 })).toBe(0);
  });

  it('延迟越高分越低', () => {
    const fast = scoreOf({ ok: 10, fail: 0, okMsSum: 10 * 300, failStreak: 0 });
    const slow = scoreOf({ ok: 10, fail: 0, okMsSum: 10 * 9000, failStreak: 0 });
    expect(fast).toBeGreaterThan(slow);
  });

  it('连续失败额外扣分：同样成功率下 streak 越长分越低', () => {
    const a = scoreOf({ ok: 5, fail: 5, okMsSum: 5 * 1000, failStreak: 0 });
    const b = scoreOf({ ok: 5, fail: 5, okMsSum: 5 * 1000, failStreak: 4 });
    expect(a).toBeGreaterThan(b);
  });

  it('评分夹在 0–100', () => {
    expect(scoreOf({ ok: 100, fail: 0, okMsSum: 0, failStreak: 0 })).toBeLessThanOrEqual(100);
    expect(scoreOf({ ok: 0, fail: 100, okMsSum: 0, failStreak: 99 })).toBeGreaterThanOrEqual(0);
  });
});

describe('registerSources / recordSourceResult', () => {
  beforeEach(() => {
    fake.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strm-sources-'));
    __resetStrmSourcesForTest();
  });

  it('登记新源并补名称；重复登记是幂等的', () => {
    expect(registerSources([{ name: '源A', url: 'http://a.com/vod/' }])).toBe(1);
    // 尾斜杠不同视为同一个源，只补名称
    expect(registerSources([{ name: '源A改名', url: 'http://a.com/vod' }])).toBe(0);
    const views = sourceViews();
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe('源A改名');
    expect(views[0].score).toBe(NEUTRAL_SCORE);
  });

  it('非法地址不登记', () => {
    expect(registerSources([{ name: 'x', url: 'ftp://bad' }, { name: 'y', url: '' }])).toBe(0);
    expect(sourceViews()).toHaveLength(0);
  });

  it('成功记录清零连续失败并累计延迟', () => {
    recordSourceResult({ url: 'http://a.com/vod', name: 'A', ok: false });
    recordSourceResult({ url: 'http://a.com/vod', ok: false });
    let views = sourceViews();
    expect(views[0].failStreak).toBe(2);
    expect(views[0].name).toBe('A');

    recordSourceResult({ url: 'http://a.com/vod', ok: true, ms: 1200 });
    views = sourceViews();
    expect(views[0].ok).toBe(1);
    expect(views[0].fail).toBe(2);
    expect(views[0].failStreak).toBe(0);
    expect(views[0].avgMs).toBe(1200);
    expect(views[0].lastOkAt).toBeDefined();
    expect(sourceNameOf('http://a.com/vod/')).toBe('A');
  });

  it('落盘后能从磁盘恢复（模拟重启）', () => {
    recordSourceResult({ url: 'http://a.com/vod', name: 'A', ok: true, ms: 800 });
    flushSources();
    const raw = JSON.parse(
      fs.readFileSync(path.join(fake.dataDir, 'sources.json'), 'utf8')
    ) as { sources: Array<{ url: string; ok: number }> };
    expect(raw.sources).toHaveLength(1);
    expect(raw.sources[0].url).toBe('http://a.com/vod');
    expect(raw.sources[0].ok).toBe(1);
  });

  it('采样窗口滚动：样本超过上限后减半', () => {
    for (let i = 0; i < 130; i++) {
      recordSourceResult({ url: 'http://a.com/vod', ok: true, ms: 100 });
    }
    const view = sourceViews()[0];
    expect(view.ok).toBeLessThan(130);
    expect(view.ok).toBeGreaterThanOrEqual(60);
  });

  it('rankedCandidates 排除原源、过滤 0 分源并按分数截断', () => {
    registerSources([
      { name: '原源', url: 'http://origin.com/vod' },
      { name: '高分', url: 'http://good.com/vod' },
      { name: '低分', url: 'http://bad.com/vod' },
      { name: '中性', url: 'http://new.com/vod' },
    ]);
    // 高分：全成功；低分：全失败（score 0 被过滤）；原源排除；中性 50 分保留
    for (let i = 0; i < 5; i++) {
      recordSourceResult({ url: 'http://good.com/vod', ok: true, ms: 100 });
      recordSourceResult({ url: 'http://bad.com/vod', ok: false });
    }
    const cands = rankedCandidates('http://origin.com/vod/', 4);
    expect(cands.map((c) => c.name)).toEqual(['高分', '中性']);

    const top1 = rankedCandidates('http://origin.com/vod', 1);
    expect(top1.map((c) => c.name)).toEqual(['高分']);
  });

  it('sourceViews 按分数降序、同分按样本数排', () => {
    registerSources([
      { name: 'A', url: 'http://a.com/vod' },
      { name: 'B', url: 'http://b.com/vod' },
    ]);
    for (let i = 0; i < 3; i++) recordSourceResult({ url: 'http://a.com/vod', ok: true, ms: 100 });
    for (let i = 0; i < 10; i++) recordSourceResult({ url: 'http://b.com/vod', ok: true, ms: 100 });
    const views = sourceViews();
    expect(views[0].name).toBe('B');
    expect(views[1].name).toBe('A');
  });
});
