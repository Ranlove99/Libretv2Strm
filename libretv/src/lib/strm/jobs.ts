/* STRM 检查 / 修复作业：在服务端进程内执行并落盘。
 *
 * 为什么不用同步 HTTP 请求：请求一断（关页面、切后台、服务重启）任务就没了，
 * 用户下次进来只能从头开始。作业模型把状态写进 jobs.json：
 *   - 每处理完一个文件就更新进度并落盘，页面只是「观察者」，关了不影响执行；
 *   - 重新进入时读同一份作业，进度与明细都在，不必重新探测；
 *   - 继续执行只处理未完成的项，已成功的文件直接跳过（断点续传）；
 *   - 进程异常退出后心跳过期，下次读取标记为 paused，由启动器自动接手（限次数）。
 */

/* eslint-disable no-console */

import fs from 'node:fs';
import path from 'node:path';
import { getStrmConfig, strmDataRoot } from './config';
import { checkAndRepairStrm } from './repair';
import { registerSources, recordSourceResult } from './source-stats';
import { listTasks } from './tasks';
import type { StrmJob, StrmJobFile, StrmJobStatus, StrmJobView, StrmRepairDetail } from './types';

const JOBS_FILE = 'jobs.json';
/** 保留的作业条数（运行中的一律保留） */
const MAX_JOBS = 8;
/** 落盘节流：进度变化很密，合并写入，避免频繁刷盘 */
const SAVE_INTERVAL_MS = 800;
/** 心跳超过该值且没有执行器 → 判为进程中断 */
const STALE_MS = 15_000;
/** 批量检查的并发数：验证是 IO 等待，适度并发能把一轮检查压到可接受时长 */
const CHECK_CONCURRENCY = 6;
/** 批量检查不做失败重试：一个失效源重试三次要 60 秒，几百个文件会拖到几小时 */
const VERIFY_RETRIES = 0;
/** 批量检查的单次验证超时 */
const VERIFY_TIMEOUT_MS = 12_000;
/** 返回给前端的明细上限 */
const MAX_PROBLEMS = 500;
/** 自动续跑上限，避免「一启动就崩」的循环 */
const MAX_RESUME = 3;

interface Runner {
  ctrl: AbortController;
  promise: Promise<void>;
}

interface JobState {
  jobs: StrmJob[] | null;
  saveTimer: NodeJS.Timeout | null;
}

const STATE_KEY = '__LIBRETV_STRM_JOBS__';
const RUNNER_KEY = '__LIBRETV_STRM_JOB_RUNNERS__';
const HOOK_KEY = '__LIBRETV_STRM_JOB_HOOKS__';

/** 作业结束（完成 / 暂停 / 取消 / 失败）时的回调：自动任务用它回写「上次执行」 */
type JobFinishHook = (job: StrmJob) => void;

export function onJobFinished(hook: JobFinishHook): void {
  const g = globalThis as unknown as Record<string, Set<JobFinishHook> | undefined>;
  if (!g[HOOK_KEY]) g[HOOK_KEY] = new Set();
  g[HOOK_KEY]!.add(hook);
}

function notifyFinished(job: StrmJob): void {
  const g = globalThis as unknown as Record<string, Set<JobFinishHook> | undefined>;
  const hooks = g[HOOK_KEY];
  if (!hooks) return;
  for (const hook of hooks) {
    try {
      hook(job);
    } catch (err) {
      console.error('[strm-jobs] 完成回调失败:', err);
    }
  }
}

function state(): JobState {
  const g = globalThis as unknown as Record<string, JobState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { jobs: null, saveTimer: null };
  return g[STATE_KEY] as JobState;
}

function runners(): Map<string, Runner> {
  const g = globalThis as unknown as Record<string, Map<string, Runner> | undefined>;
  if (!g[RUNNER_KEY]) g[RUNNER_KEY] = new Map();
  return g[RUNNER_KEY] as Map<string, Runner>;
}

function jobsPath(): string {
  return path.join(strmDataRoot(), JOBS_FILE);
}

/* ------------------------------ 存储 ------------------------------ */

export function loadJobs(): StrmJob[] {
  const s = state();
  if (s.jobs) return s.jobs;
  try {
    const parsed = JSON.parse(fs.readFileSync(jobsPath(), 'utf8')) as StrmJob[];
    s.jobs = Array.isArray(parsed) ? parsed : [];
  } catch {
    s.jobs = [];
  }
  return s.jobs;
}

function persistNow(): void {
  const s = state();
  if (!s.jobs) return;
  try {
    fs.mkdirSync(strmDataRoot(), { recursive: true });
    const target = jobsPath();
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(prune(s.jobs)), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('[strm-jobs] 保存作业失败:', err);
  }
}

/** 节流落盘：连续变化合并成一次写 */
function scheduleSave(): void {
  const s = state();
  if (s.saveTimer) return;
  s.saveTimer = setTimeout(() => {
    s.saveTimer = null;
    persistNow();
  }, SAVE_INTERVAL_MS);
  if (typeof s.saveTimer.unref === 'function') s.saveTimer.unref();
}

/** 立即落盘（作业结束、状态切换时用） */
export function flushJobs(): void {
  const s = state();
  if (s.saveTimer) {
    clearTimeout(s.saveTimer);
    s.saveTimer = null;
  }
  persistNow();
}

/** 只保留最近若干条：运行中 / 暂停的必留，其余按创建时间倒序截断 */
function prune(jobs: StrmJob[]): StrmJob[] {
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'paused');
  const rest = jobs
    .filter((j) => j.status !== 'running' && j.status !== 'paused')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(0, MAX_JOBS - active.length));
  return [...active, ...rest].sort((a, b) => b.createdAt - a.createdAt);
}

/* ------------------------------ 视图 ------------------------------ */

function remainingOf(job: StrmJob): number {
  return job.files.reduce((n, f) => (f.state === 'pending' ? n + 1 : n), 0);
}

export function jobView(job: StrmJob): StrmJobView {
  const problems = job.files.filter((f) => f.state !== 'pending' && f.state !== 'ok');
  return {
    id: job.id,
    status: job.status,
    trigger: job.trigger,
    options: job.options,
    total: job.total,
    done: job.done,
    ok: job.ok,
    fixed: job.fixed,
    deepFixed: job.deepFixed,
    fail: job.fail,
    pendingRepair: job.pendingRepair,
    verifyFailed: job.verifyFailed,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ms: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : undefined,
    note: job.note,
    current: job.current,
    problems: problems.slice(0, MAX_PROBLEMS),
    problemsTotal: problems.length,
    remaining: remainingOf(job),
  };
}

export function getJob(id: string): StrmJob | undefined {
  return loadJobs().find((j) => j.id === id);
}

export function listJobs(limit = 6): StrmJobView[] {
  return loadJobs()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(1, limit))
    .map(jobView);
}

export function findActiveJob(): StrmJob | undefined {
  return loadJobs().find((j) => j.status === 'running');
}

export function isJobRunning(id: string): boolean {
  return runners().has(id);
}

/* ------------------------------ 创建 ------------------------------ */

function newJobId(): string {
  return `chk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export interface CreateJobOptions {
  trigger?: 'manual' | 'auto';
  repair?: boolean;
  deep?: boolean;
  verify?: boolean;
}

/**
 * 创建作业。已有同类作业在跑时直接复用（返回 reused=true），
 * 避免用户连点两次产生两条同时改写同一批文件的作业。
 */
export function createJob(
  files: string[],
  opts: CreateJobOptions = {}
): { job: StrmJob; reused: boolean } {
  const active = findActiveJob();
  if (active) return { job: active, reused: true };

  const now = Date.now();
  const job: StrmJob = {
    id: newJobId(),
    status: 'paused',
    trigger: opts.trigger === 'auto' ? 'auto' : 'manual',
    options: {
      repair: opts.repair !== false,
      deep: opts.deep === true,
      verify: opts.verify === true,
    },
    total: files.length,
    done: 0,
    ok: 0,
    fixed: 0,
    deepFixed: 0,
    fail: 0,
    pendingRepair: 0,
    verifyFailed: 0,
    createdAt: now,
    heartbeatAt: now,
    resumeCount: 0,
    files: files.map((file) => ({ file, state: 'pending' as const })),
  };
  loadJobs().unshift(job);
  flushJobs();
  return { job, reused: false };
}

/* ------------------------------ 执行 ------------------------------ */

function noteOf(job: StrmJob): string {
  if (job.total === 0) return '输出目录里没有 .strm 文件';
  const parts = [`扫描 ${job.total}`, `正常 ${job.ok}`];
  if (job.fixed > 0) parts.push(`结构修复 ${job.fixed}`);
  if (job.deepFixed > 0) parts.push(`回源修复 ${job.deepFixed}`);
  if (job.pendingRepair > 0) parts.push(`可修未改 ${job.pendingRepair}`);
  if (job.fail > 0) parts.push(`仍失效 ${job.fail}`);
  if (job.verifyFailed > 0) parts.push(`验证失败 ${job.verifyFailed}`);
  return parts.join(' · ');
}

/** 单个文件结算：更新统计与明细 */
function applyFileResult(job: StrmJob, entry: StrmJobFile, detail?: StrmRepairDetail): void {
  entry.reason = detail?.reason;
  entry.issues = detail?.issues;
  entry.verify = detail?.verify;
  entry.verifyError = detail?.verifyError;
  entry.deepSource = detail?.deepSource;

  if (!detail) {
    entry.state = 'ok';
    job.ok += 1;
  } else if (detail.deepFixed) {
    entry.state = 'deep-fixed';
    job.deepFixed += 1;
  } else if (detail.fixed) {
    entry.state = 'fixed';
    job.fixed += 1;
  } else if (!job.options.repair) {
    // 只读检查：有问题一律算「可修未改」，用户没有要求写文件
    entry.state = 'fail';
    job.pendingRepair += 1;
  } else {
    entry.state = 'fail';
    job.fail += 1;
  }

  if (detail?.verify === 'fail') job.verifyFailed += 1;
  job.done += 1;
  job.heartbeatAt = Date.now();
}

/**
 * 启动（或继续）作业。返回的 Promise 在作业结束（完成 / 暂停 / 取消 / 失败）时 resolve。
 * 自动任务用它拿结果回写 auto.json。
 */
export function startJob(job: StrmJob): Promise<void> {
  const map = runners();
  const existing = map.get(job.id);
  if (existing) return existing.promise;

  const ctrl = new AbortController();
  const promise = (async () => {
    const startedAt = Date.now();
    job.status = 'running';
    job.startedAt = job.startedAt ?? startedAt;
    job.finishedAt = undefined;
    job.pausedBy = undefined;
    job.note = undefined;
    job.heartbeatAt = startedAt;
    flushJobs();

    const index = new Map<string, StrmJobFile>();
    for (const f of job.files) index.set(f.file, f);
    const pending = job.files.filter((f) => f.state === 'pending').map((f) => f.file);

    try {
      if (pending.length === 0) {
        job.status = 'done';
        job.finishedAt = Date.now();
        job.note = noteOf(job);
        return;
      }

      const cfg = getStrmConfig();
      const tasks = listTasks();
      // 服务端源注册表兜底：任务记录里出现过的源全部登记（前端没上报过也有评分可用）
      registerSources(
        tasks.flatMap((t) =>
          t.items.map((i) => ({ key: i.sourceKey, name: i.sourceName, url: i.sourceUrl }))
        )
      );
      await checkAndRepairStrm(cfg, tasks, {
        repair: job.options.repair,
        deep: job.options.deep,
        verify: job.options.verify,
        crossSource: cfg.crossSourceRepair,
        files: pending,
        concurrency: CHECK_CONCURRENCY,
        verifyRetries: VERIFY_RETRIES,
        verifyTimeoutMs: VERIFY_TIMEOUT_MS,
        signal: ctrl.signal,
        // 每次源探测（拉详情 / 跨源尝试）都累计评分：成功率、延迟、连续失败
        onSource: (info) => {
          try {
            recordSourceResult(info);
          } catch {
            // 评分记录失败不影响修复本身
          }
        },
        onStart: (file) => {
          // 只更新内存里的「正在处理」，不落盘：纯展示信息，丢了无所谓
          job.current = file;
        },
        onFile: ({ file, detail }) => {
          const entry = index.get(file);
          if (!entry) return;
          job.current = file;
          applyFileResult(job, entry, detail);
          scheduleSave();
        },
      });

      // 赋值 'running' 后 TS 会把 job.status 收窄，这里显式放宽回联合类型
      const finalStatus = job.status as StrmJobStatus;
      if (finalStatus === 'canceled') {
        job.note = `已取消（完成 ${job.done}/${job.total}）`;
      } else if (ctrl.signal.aborted) {
        job.status = 'paused';
        job.note = `已暂停，完成 ${job.done}/${job.total}，可继续`;
      } else {
        job.status = 'done';
        job.finishedAt = Date.now();
        job.note = noteOf(job);
      }
    } catch (err) {
      job.status = 'failed';
      job.finishedAt = Date.now();
      job.note = err instanceof Error ? err.message : '执行失败';
      console.error('[strm-jobs] 作业失败:', err);
    } finally {
      // 只清理自己：暂停后立刻继续会换成新执行器
      if (map.get(job.id)?.ctrl === ctrl) map.delete(job.id);
      job.current = undefined;
      job.heartbeatAt = Date.now();
      flushJobs();
      notifyFinished(job);
      console.log(`[strm-jobs] ${job.id} ${job.status}：${job.note ?? ''}`);
    }
  })();

  map.set(job.id, { ctrl, promise });
  return promise;
}

/** 暂停：中止执行器，已完成的结果保留 */
export function pauseJob(id: string): StrmJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  if (job.status !== 'running') return job;
  job.pausedBy = 'user';
  runners().get(id)?.ctrl.abort();
  return job;
}

/** 继续：只跑未完成的项 */
export function resumeJob(id: string): StrmJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  if (job.status === 'running' && isJobRunning(id)) return job;
  // 手动继续重置自动续跑计数，避免用户点一次也被上限挡住
  job.resumeCount = 0;
  void startJob(job);
  return job;
}

/** 取消：中止并标记，不会自动续跑 */
export function cancelJob(id: string): StrmJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  if (job.status === 'running') {
    job.status = 'canceled';
    job.pausedBy = 'user';
    runners().get(id)?.ctrl.abort();
  } else if (job.status === 'paused') {
    job.status = 'canceled';
    job.finishedAt = Date.now();
  }
  job.note = job.note || '已取消';
  flushJobs();
  return job;
}

/* ------------------------------ 自愈 ------------------------------ */

/**
 * 把「进程已死但状态还是 running」的记录修正为 paused。
 * 读取接口每次调用（幂等），避免页面一直转圈。
 */
export function healStaleJobs(): number {
  const now = Date.now();
  let changed = 0;
  for (const job of loadJobs()) {
    if (job.status !== 'running') continue;
    if (isJobRunning(job.id)) continue;
    if (now - (job.heartbeatAt || 0) < STALE_MS) continue;
    job.status = 'paused';
    job.pausedBy = 'restart';
    job.note = `服务中断，已完成 ${job.done}/${job.total}，可继续`;
    changed += 1;
  }
  if (changed > 0) flushJobs();
  return changed;
}

/**
 * 应用启动后自动接手被中断的作业（限次数，避免崩溃循环）。
 * 用户主动暂停的不碰。
 */
export function resumeInterruptedJobs(): { resumed: string[]; skipped: string[] } {
  const out = { resumed: [] as string[], skipped: [] as string[] };
  const jobs = loadJobs();

  // 启动阶段不存在执行器：凡是 running 的记录都是上个进程留下的孤儿
  for (const job of jobs) {
    if (job.status === 'running' && !isJobRunning(job.id)) {
      job.status = 'paused';
      job.pausedBy = 'restart';
      job.note = `服务重启，已完成 ${job.done}/${job.total}，可继续`;
    }
  }
  healStaleJobs();

  for (const job of jobs) {
    if (job.status !== 'paused') continue;
    if (job.pausedBy === 'user') continue;
    if (isJobRunning(job.id)) continue;
    if (job.resumeCount >= MAX_RESUME) {
      job.note = '多次中断，请手动点击继续';
      out.skipped.push(job.id);
      continue;
    }
    job.resumeCount += 1;
    void startJob(job);
    out.resumed.push(job.id);
  }
  if (out.resumed.length > 0 || out.skipped.length > 0) flushJobs();
  return out;
}

/** 测试用：清空内存缓存与执行器 */
export function __resetStrmJobsForTest(): void {
  const s = state();
  if (s.saveTimer) {
    clearTimeout(s.saveTimer);
    s.saveTimer = null;
  }
  s.jobs = null;
  for (const r of runners().values()) r.ctrl.abort();
  runners().clear();
}
