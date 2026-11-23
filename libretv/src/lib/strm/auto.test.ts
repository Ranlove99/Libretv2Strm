import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StrmConfig, StrmJob } from './types';

/** STRM 定时检查：频率计算（按天/按小时）/ 到期判断 / 当天去重 / 补跑窗口 / 作业创建 */

const fake = vi.hoisted(() => ({
  dataDir: '',
  cfg: null as StrmConfig | null,
  jobs: [] as StrmJob[],
  created: [] as { files: string[]; opts: Record<string, unknown> | undefined }[],
  started: [] as string[],
  scanFiles: [] as string[],
  startHook: null as null | (() => void),
  hooks: [] as ((job: StrmJob) => void)[],
}));

vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return {
    ...actual,
    getStrmConfig: () => fake.cfg as StrmConfig,
    strmDataRoot: () => fake.dataDir,
  };
});

vi.mock('./repair', () => ({
  collectStrmFiles: async () => ({ files: fake.scanFiles, truncated: false }),
}));

vi.mock('./jobs', () => ({
  onJobFinished: (hook: (job: StrmJob) => void) => {
    fake.hooks.push(hook);
  },
  createJob: (files: string[], opts?: Record<string, unknown>) => {
    const job = {
      id: `job-${fake.created.length + 1}`,
      status: 'paused',
      trigger: opts?.trigger === 'auto' ? 'auto' : 'manual',
      options: { repair: true, deep: false, verify: false },
      total: files.length,
      done: 0,
      ok: 0,
      fixed: 0,
      deepFixed: 0,
      fail: 0,
      pendingRepair: 0,
      verifyFailed: 0,
      createdAt: Date.now(),
      heartbeatAt: Date.now(),
      resumeCount: 0,
      files: files.map((file) => ({ file, state: 'pending' as const })),
    } as StrmJob;
    fake.created.push({ files, opts });
    fake.jobs.unshift(job);
    return { job, reused: false };
  },
  findActiveJob: () => fake.jobs.find((j) => j.status === 'running'),
  loadJobs: () => fake.jobs,
  startJob: (job: StrmJob) => {
    fake.started.push(job.id);
    // 没设 startHook 表示「作业还在跑」：不触发完成回调
    if (!fake.startHook) return Promise.resolve();
    const finish = fake.startHook;
    return Promise.resolve().then(() => {
      finish();
      // 模拟作业结束时的完成回调
      for (const hook of fake.hooks) hook(job);
    });
  },
}));

import {
  autoSummary,
  autoTick,
  getAutoState,
  isDue,
  nextRunAt,
  plannedAt,
  runAutoCheck,
  slotKey,
  __resetStrmAutoForTest,
} from './auto';
import { normalizeHhmm } from './config';

function baseCfg(over: Partial<StrmConfig> = {}): StrmConfig {
  return {
    outputDir: '/tmp/strm',
    urlMode: 'direct',
    publicBaseUrl: '',
    movieTemplate: '{title} ({year})',
    tvTemplate: '{title} - S{season:02d}E{episode:02d}',
    generateNfo: true,
    downloadPoster: true,
    separateTv: true,
    concurrency: 2,
    maxEpisodes: 0,
    verifyAfterGenerate: true,
    autoCheck: true,
    autoCheckMode: 'daily',
    autoCheckAt: '03:00',
    autoCheckEveryDays: 1,
    autoCheckEveryHours: 6,
    autoFix: true,
    crossSourceRepair: true,
    ...over,
  };
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  fake.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strm-auto-'));
  fake.cfg = baseCfg();
  fake.jobs = [];
  fake.created = [];
  fake.started = [];
  fake.scanFiles = ['a.strm', 'b.strm'];
  fake.startHook = null;
  __resetStrmAutoForTest();
});

describe('normalizeHhmm', () => {
  it('补齐两位并接受多种写法', () => {
    expect(normalizeHhmm('3:5')).toBe('03:05');
    expect(normalizeHhmm('03:00')).toBe('03:00');
    expect(normalizeHhmm('23：59')).toBe('23:59');
    expect(normalizeHhmm('930')).toBe('09:30');
    expect(normalizeHhmm('7')).toBe('07:00');
  });

  it('非法值回落到 03:00', () => {
    expect(normalizeHhmm('24:00')).toBe('03:00');
    expect(normalizeHhmm('12:60')).toBe('03:00');
    expect(normalizeHhmm('abc')).toBe('03:00');
    expect(normalizeHhmm(undefined)).toBe('03:00');
    expect(normalizeHhmm(1234)).toBe('03:00');
  });
});

describe('时间基础计算', () => {
  it('plannedAt 取当天该时刻', () => {
    const p = plannedAt(new Date(2026, 10, 23, 18, 30), '03:00');
    expect([p.getFullYear(), p.getMonth(), p.getDate(), p.getHours(), p.getMinutes()]).toEqual([
      2026, 10, 23, 3, 0,
    ]);
  });

  it('slotKey 是本机时区的 YYYY-MM-DD HH:mm', () => {
    expect(slotKey(new Date(2026, 0, 5, 9, 7), '03:00')).toBe('2026-01-05 03:00');
  });
});

describe('isDue：按天模式', () => {
  it('未开启一律 false', () => {
    expect(isDue(baseCfg({ autoCheck: false }), {}, new Date(2026, 10, 23, 3, 0))).toBe(false);
  });

  it('未到点 false，到点 true', () => {
    const cfg = baseCfg();
    expect(isDue(cfg, {}, new Date(2026, 10, 23, 2, 59))).toBe(false);
    expect(isDue(cfg, {}, new Date(2026, 10, 23, 3, 0))).toBe(true);
  });

  it('当天这个时段已跑过就不再跑', () => {
    const cfg = baseCfg();
    const state = { lastSlot: '2026-11-23 03:00' };
    expect(isDue(cfg, state, new Date(2026, 10, 23, 3, 30))).toBe(false);
    expect(isDue(cfg, state, new Date(2026, 10, 24, 3, 30))).toBe(true);
  });

  it('错过 6 小时内补跑，超过窗口不跑', () => {
    const cfg = baseCfg();
    expect(isDue(cfg, {}, new Date(2026, 10, 23, 8, 59))).toBe(true);
    expect(isDue(cfg, {}, new Date(2026, 10, 23, 9, 1))).toBe(false);
  });

  it('多天间隔：距上次不足 N 天不跑，够 N 天才跑', () => {
    const cfg = baseCfg({ autoCheckEveryDays: 3 });
    const now = new Date(2026, 10, 23, 3, 5);
    expect(isDue(cfg, { lastRunAt: now.getTime() - 2 * DAY }, now)).toBe(false);
    expect(isDue(cfg, { lastRunAt: now.getTime() - 3 * DAY }, now)).toBe(true);
  });

  it('今天已有手动作业跑完 → 定时不再重复', () => {
    const cfg = baseCfg();
    const now = new Date(2026, 10, 23, 3, 5);
    fake.jobs = [
      {
        id: 'm1',
        trigger: 'manual',
        status: 'done',
        finishedAt: now.getTime() - 60_000,
      } as StrmJob,
    ];
    expect(isDue(cfg, {}, now)).toBe(false);
  });
});

describe('isDue：按小时模式', () => {
  it('从未跑过时先等一个间隔', () => {
    const cfg = baseCfg({ autoCheckMode: 'interval', autoCheckEveryHours: 6 });
    expect(isDue(cfg, {}, new Date(2026, 10, 23, 12, 0))).toBe(false);
  });

  it('距上次不足间隔不跑，够了就跑', () => {
    const cfg = baseCfg({ autoCheckMode: 'interval', autoCheckEveryHours: 6 });
    const now = new Date(2026, 10, 23, 12, 0);
    expect(isDue(cfg, { lastRunAt: now.getTime() - 5 * 3600_000 }, now)).toBe(false);
    expect(isDue(cfg, { lastRunAt: now.getTime() - 7 * 3600_000 }, now)).toBe(true);
  });
});

describe('nextRunAt', () => {
  it('按天：未到点是今天，已过点是明天', () => {
    const cfg = baseCfg();
    expect(nextRunAt(cfg, new Date(2026, 10, 23, 1, 0))).toBe(new Date(2026, 10, 23, 3, 0).getTime());
    expect(nextRunAt(cfg, new Date(2026, 10, 23, 4, 0))).toBe(new Date(2026, 10, 24, 3, 0).getTime());
  });

  it('按天 + 多天间隔：跳过不够天数的日期', () => {
    const cfg = baseCfg({ autoCheckEveryDays: 3 });
    const now = new Date(2026, 10, 23, 4, 0);
    fs.writeFileSync(
      path.join(fake.dataDir, 'auto.json'),
      JSON.stringify({ lastRunAt: now.getTime() })
    );
    // 今天刚跑过 → 下一次要等到第 3 天的 03:00
    expect(nextRunAt(cfg, now)).toBe(new Date(2026, 10, 26, 3, 0).getTime());
  });

  it('按小时：从上次开始算，过期则显示一分钟后', () => {
    const cfg = baseCfg({ autoCheckMode: 'interval', autoCheckEveryHours: 6 });
    const now = new Date(2026, 10, 23, 12, 0);
    expect(nextRunAt(cfg, now)).toBe(now.getTime() + 6 * 3600_000);

    fs.writeFileSync(
      path.join(fake.dataDir, 'auto.json'),
      JSON.stringify({ lastRunAt: now.getTime() - 3600_000 })
    );
    expect(nextRunAt(cfg, now)).toBe(now.getTime() + 5 * 3600_000);

    fs.writeFileSync(
      path.join(fake.dataDir, 'auto.json'),
      JSON.stringify({ lastRunAt: now.getTime() - 7 * 3600_000 })
    );
    expect(nextRunAt(cfg, now)).toBe(now.getTime() + 60_000);
  });

  it('未开启返回 null', () => {
    expect(nextRunAt(baseCfg({ autoCheck: false }))).toBeNull();
  });
});

describe('runAutoCheck', () => {
  it('创建作业并占位当天已检查', async () => {
    const r = await runAutoCheck();
    expect(r.started).toBe(true);
    expect(r.jobId).toBe('job-1');
    expect(fake.created[0].files).toEqual(['a.strm', 'b.strm']);
    expect(fake.created[0].opts).toMatchObject({
      trigger: 'auto',
      repair: true,
      verify: true,
      deep: true,
    });

    const state = getAutoState();
    expect(state.lastSlot).toMatch(/^\d{4}-\d{2}-\d{2} 03:00$/);
    expect(state.lastResult).toContain('检查已开始');
    expect(fake.started).toEqual(['job-1']);
  });

  it('已有作业在跑时复用，不重复创建', async () => {
    fake.jobs = [{ id: 'running-1', status: 'running' } as StrmJob];
    const r = await runAutoCheck({ manual: true });
    expect(r.started).toBe(false);
    expect(r.reused).toBe(true);
    expect(r.jobId).toBe('running-1');
    expect(fake.created).toHaveLength(0);
  });

  it('未开启且非手动时拒绝', async () => {
    fake.cfg = baseCfg({ autoCheck: false });
    const r = await runAutoCheck();
    expect(r.started).toBe(false);
    expect(r.reason).toContain('未开启');
  });

  it('作业完成后回写结果文案与统计', async () => {
    fake.startHook = () => {
      const job = fake.jobs[0];
      job.status = 'done';
      job.note = '扫描 2 · 正常 1 · 结构修复 1';
      job.done = 2;
      job.ok = 1;
      job.fixed = 1;
      job.finishedAt = Date.now();
    };
    await runAutoCheck();
    // startJob().then() 在微任务里回写
    await new Promise((r) => setTimeout(r, 0));
    const state = getAutoState();
    expect(state.lastResult).toContain('结构修复 1');
    expect(state.lastStats?.scanned).toBe(2);
  });

  it('按小时模式不写 lastSlot（否则会卡住下一次）', async () => {
    fake.cfg = baseCfg({ autoCheckMode: 'interval' });
    await runAutoCheck();
    expect(getAutoState().lastSlot).toBeUndefined();
  });
});

describe('autoTick', () => {
  it('未到点不触发', async () => {
    expect(await autoTick(new Date(2026, 10, 23, 2, 0))).toBe('idle');
    expect(fake.created).toHaveLength(0);
  });

  it('到点触发一次，同一天再 tick 不重复', async () => {
    expect(await autoTick(new Date(2026, 10, 23, 3, 0))).toBe('started');
    expect(fake.created).toHaveLength(1);
    expect(await autoTick(new Date(2026, 10, 23, 3, 1))).toBe('idle');
    expect(fake.created).toHaveLength(1);
  });
});

describe('autoSummary', () => {
  it('汇总开关、频率、下次执行与上次结果', async () => {
    await runAutoCheck();
    await new Promise((r) => setTimeout(r, 0));
    const now = new Date(2026, 10, 23, 12, 0);
    const s = autoSummary(now);
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe('daily');
    expect(s.at).toBe('03:00');
    expect(s.everyDays).toBe(1);
    expect(s.everyHours).toBe(6);
    expect(s.nextAt).toBe(new Date(2026, 10, 24, 3, 0).getTime());
    expect(s.lastResult).toBeTruthy();
  });

  it('正在跑的作业会带出进度摘要', () => {
    fake.jobs = [
      { id: 'run-1', status: 'running', trigger: 'auto', done: 3, total: 10, startedAt: 1 } as StrmJob,
    ];
    const s = autoSummary(new Date(2026, 10, 23, 12, 0));
    expect(s.activeJob).toMatchObject({ id: 'run-1', done: 3, total: 10 });
  });

  it('未开启时下次执行为 null', () => {
    fake.cfg = baseCfg({ autoCheck: false });
    expect(autoSummary().nextAt).toBeNull();
  });
});
