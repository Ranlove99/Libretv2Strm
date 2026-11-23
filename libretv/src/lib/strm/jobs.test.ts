import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StrmConfig, StrmJob } from './types';

/** 后台作业：创建/复用、进度结算、暂停续跑、取消、落盘恢复、启动自愈 */

const fake = vi.hoisted(() => ({
  dataDir: '',
  cfg: null as StrmConfig | null,
  /** 文件 → 模拟的检查结果（undefined 表示正常） */
  results: new Map<string, Record<string, unknown> | undefined>(),
  seen: [] as string[],
  stepDelay: 0,
  throwOn: '',
}));

vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>();
  return {
    ...actual,
    getStrmConfig: () => fake.cfg as StrmConfig,
    strmDataRoot: () => fake.dataDir,
  };
});

vi.mock('./tasks', () => ({ listTasks: () => [] }));

vi.mock('./repair', () => ({
  checkAndRepairStrm: async (
    _cfg: unknown,
    _tasks: unknown,
    opts: {
      files?: string[];
      signal?: AbortSignal;
      onFile?: (info: { file: string; detail?: Record<string, unknown> }) => void;
    }
  ) => {
    for (const file of opts.files ?? []) {
      if (opts.signal?.aborted) break;
      if (fake.throwOn && file === fake.throwOn) throw new Error('上游不可达');
      fake.seen.push(file);
      opts.onFile?.({ file, detail: fake.results.get(file) });
      if (fake.stepDelay > 0) await new Promise((r) => setTimeout(r, fake.stepDelay));
    }
    return {
      root: '/tmp',
      scanned: (opts.files ?? []).length,
      ok: 0,
      fixed: 0,
      deepFixed: 0,
      unfixable: 0,
      pendingRepair: 0,
      verifyFailed: 0,
      truncated: false,
      details: [],
    };
  },
}));

import {
  cancelJob,
  createJob,
  findActiveJob,
  flushJobs,
  getJob,
  healStaleJobs,
  jobView,
  loadJobs,
  onJobFinished,
  pauseJob,
  resumeInterruptedJobs,
  resumeJob,
  startJob,
  __resetStrmJobsForTest,
} from './jobs';

function baseCfg(over: Partial<StrmConfig> = {}): StrmConfig {
  return {
    outputDir: '/tmp/strm',
    urlMode: 'direct',
    publicBaseUrl: '',
    movieTemplate: '{title}',
    tvTemplate: '{title}',
    generateNfo: false,
    downloadPoster: false,
    separateTv: false,
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
    ...over,
  };
}

/** 等作业进入终态（startJob 不阻塞调用方） */
async function settle(job: StrmJob, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (job.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  fake.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strm-jobs-'));
  fake.cfg = baseCfg();
  fake.results = new Map();
  fake.seen = [];
  fake.stepDelay = 0;
  fake.throwOn = '';
  __resetStrmJobsForTest();
});

describe('createJob', () => {
  it('初始化文件清单与统计', () => {
    const { job, reused } = createJob(['a.strm', 'b.strm'], { verify: true });
    expect(reused).toBe(false);
    expect(job.total).toBe(2);
    expect(job.files.map((f) => f.state)).toEqual(['pending', 'pending']);
    expect(job.options).toMatchObject({ repair: true, deep: false, verify: true });
    expect(findActiveJob()).toBeUndefined(); // 还没 start
  });

  it('已有作业在跑时复用同一条', () => {
    const { job } = createJob(['a.strm'], {});
    job.status = 'running';
    const second = createJob(['b.strm'], {});
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(job.id);
    expect(loadJobs()).toHaveLength(1);
  });
});

describe('startJob 进度结算', () => {
  it('正常文件计入 ok，问题文件按修复方式归类', async () => {
    fake.results = new Map([
      ['b.strm', { file: 'b.strm', kind: 'direct', issues: ['whitespace'], fixed: true }],
      ['c.strm', { file: 'c.strm', kind: 'invalid', issues: ['empty'], reason: '文件为空' }],
      ['d.strm', { file: 'd.strm', kind: 'direct', issues: [], deepFixed: true, verify: 'ok' }],
    ]);
    const { job } = createJob(['a.strm', 'b.strm', 'c.strm', 'd.strm'], { repair: true });
    await startJob(job);

    expect(job.status).toBe('done');
    expect(job.done).toBe(4);
    expect(job.ok).toBe(1);
    expect(job.fixed).toBe(1);
    expect(job.deepFixed).toBe(1);
    expect(job.fail).toBe(1);
    expect(job.note).toContain('扫描 4');
    expect(job.note).toContain('结构修复 1');
  });

  it('只读模式（repair=false）把问题算作「可修未改」', async () => {
    fake.results = new Map([
      ['a.strm', { file: 'a.strm', kind: 'direct', issues: ['whitespace'] }],
    ]);
    const { job } = createJob(['a.strm'], { repair: false });
    await startJob(job);
    expect(job.pendingRepair).toBe(1);
    expect(job.fail).toBe(0);
  });

  it('验证失败单独计数', async () => {
    fake.results = new Map([
      ['a.strm', { file: 'a.strm', kind: 'direct', issues: [], verify: 'fail', verifyError: '403' }],
    ]);
    const { job } = createJob(['a.strm'], { repair: true, verify: true });
    await startJob(job);
    expect(job.verifyFailed).toBe(1);
    expect(job.fail).toBe(1);
  });

  it('空目录直接完成并给出文案', async () => {
    const { job } = createJob([], {});
    await startJob(job);
    expect(job.status).toBe('done');
    expect(job.note).toContain('没有 .strm');
  });

  it('执行异常标记 failed 并保留原因', async () => {
    fake.throwOn = 'a.strm';
    const { job } = createJob(['a.strm', 'b.strm'], {});
    await startJob(job);
    expect(job.status).toBe('failed');
    expect(job.note).toContain('上游不可达');
  });
});

describe('暂停 / 继续 / 取消', () => {
  it('暂停保留已完成进度，继续时只跑剩下的', async () => {
    fake.stepDelay = 15;
    const { job } = createJob(['a.strm', 'b.strm', 'c.strm', 'd.strm'], {});
    const p = startJob(job);
    await new Promise((r) => setTimeout(r, 5));
    pauseJob(job.id);
    await p;

    expect(job.status).toBe('paused');
    const doneBefore = job.done;
    expect(doneBefore).toBeLessThan(4);
    expect(jobView(job).remaining).toBe(4 - doneBefore);

    fake.stepDelay = 0;
    await startJob(job);
    expect(job.status).toBe('done');
    expect(job.done).toBe(4);
    // 每个文件只被处理一次
    expect(new Set(fake.seen).size).toBe(fake.seen.length);
  });

  it('取消后不再自动续跑', async () => {
    const { job } = createJob(['a.strm'], {});
    await startJob(job);
    cancelJob(job.id);
    expect(getJob(job.id)?.status).toBe('done'); // 已完成的不改状态
    expect(resumeInterruptedJobs().resumed).toHaveLength(0);
  });

  it('resumeJob 让暂停的作业继续', async () => {
    const { job } = createJob(['a.strm'], {});
    job.status = 'paused';
    job.files[0].state = 'pending';
    resumeJob(job.id);
    await settle(job);
    expect(job.status).toBe('done');
  });
});

describe('落盘与自愈', () => {  it('flush 后能从文件读回', async () => {
    const { job } = createJob(['a.strm', 'b.strm'], {});
    await startJob(job);
    flushJobs();
    __resetStrmJobsForTest();
    const jobs = loadJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(job.id);
    expect(jobs[0].done).toBe(2);
  });

  it('服务重启后接手 running 的孤儿作业', async () => {
    // 手工写一条「进程已死但状态还是 running」的记录
    fs.writeFileSync(
      path.join(fake.dataDir, 'jobs.json'),
      JSON.stringify([
        {
          id: 'orphan',
          status: 'running',
          trigger: 'manual',
          options: { repair: true, deep: false, verify: false },
          total: 1,
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
          files: [{ file: 'a.strm', state: 'pending' }],
        },
      ])
    );
    __resetStrmJobsForTest();

    const r = resumeInterruptedJobs();
    expect(r.resumed).toEqual(['orphan']);
    const job = getJob('orphan');
    expect(job).toBeTruthy();
    await settle(job as StrmJob);
    expect(job?.status).toBe('done');
  });

  it('用户主动暂停的作业不会被自动接手', () => {
    const { job } = createJob(['a.strm'], {});
    job.status = 'paused';
    job.pausedBy = 'user';
    flushJobs();
    __resetStrmJobsForTest();
    expect(resumeInterruptedJobs().resumed).toHaveLength(0);
  });

  it('healStaleJobs 把无执行器的 running 改判为暂停', () => {
    const { job } = createJob(['a.strm'], {});
    job.status = 'running';
    job.heartbeatAt = Date.now() - 60_000;
    flushJobs();
    __resetStrmJobsForTest();
    expect(healStaleJobs()).toBe(1);
    expect(getJob(job.id)?.status).toBe('paused');
  });
});

describe('完成回调', () => {
  it('作业结束（完成/暂停）都会通知订阅者', async () => {
    const seen: string[] = [];
    onJobFinished((j) => seen.push(`${j.id}:${j.status}`));

    const { job } = createJob(['a.strm'], {});
    await startJob(job);
    expect(seen).toContain(`${job.id}:done`);

    fake.stepDelay = 20;
    const second = createJob(['b.strm', 'c.strm'], {}).job;
    const p = startJob(second);
    await new Promise((r) => setTimeout(r, 5));
    pauseJob(second.id);
    await p;
    expect(seen).toContain(`${second.id}:paused`);
  });
});
