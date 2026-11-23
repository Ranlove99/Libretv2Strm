/* STRM 自动检查 / 自动修复：按设置的频率触发检查作业，检查完按配置决定是否自动修复。
 *
 * 设计取舍：
 *   - 不引入 cron 表达式：用户只需要「每 N 天几点」或「每 N 小时」，省掉写表达式的门槛。
 *   - 触发由进程内调度器每分钟 tick 一次（./scheduler.ts），不用系统 crontab，
 *     也就没有 fnOS 下的路径与权限差异问题。
 *   - 真正的执行交给后台作业（./jobs.ts）：作业落盘、可续跑、页面关掉不影响。
 *   - 去重靠 slot（'YYYY-MM-DD HH:mm'）与 lastRunAt 落盘到 auto.json，进程重启不会补跑两遍；
 *     daily 模式允许「当天错过了几小时内补跑」，避免 NAS 白天关机导致整天不检查。
 */

/* eslint-disable no-console */

import fs from 'node:fs';
import path from 'node:path';
import { getStrmConfig, normalizeHhmm, strmDataRoot } from './config';
import { createJob, findActiveJob, loadJobs, onJobFinished, startJob } from './jobs';
import { collectStrmFiles } from './repair';
import type { StrmAutoState, StrmAutoStats, StrmAutoSummary, StrmConfig, StrmJob } from './types';

const STATE_FILE = 'auto.json';
/** daily 模式错过计划时刻后仍补跑的窗口（6 小时） */
const CATCH_UP_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function statePath(): string {
  return path.join(strmDataRoot(), STATE_FILE);
}

/** 读状态：读失败（首次运行 / 文件损坏）一律当空状态，不影响主流程 */
export function getAutoState(): StrmAutoState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as StrmAutoState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveAutoState(next: StrmAutoState): void {
  try {
    fs.mkdirSync(strmDataRoot(), { recursive: true });
    const target = statePath();
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    // 只读数据目录时放弃落盘：内存态仍然正确，只是重启后会重跑一次
    console.error('[strm-auto] 保存自动任务状态失败:', err);
  }
}

/* ── 时间计算 ── */

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** 'YYYY-MM-DD HH:mm'（本机时区），作为一次性执行的去重键 */
export function slotKey(d: Date, at: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${normalizeHhmm(at)}`;
}

/** 某个时间点当天的计划时刻 */
export function plannedAt(base: Date, at: string): Date {
  const [h, m] = normalizeHhmm(at).split(':').map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

/** 今天是否已经有「手动」作业跑完（手动全量检查过就算当天已检查，定时不再重复） */
function manualCheckedToday(now: Date): boolean {
  const since = startOfDay(now).getTime();
  return loadJobs().some(
    (j) => j.trigger === 'manual' && j.status === 'done' && (j.finishedAt ?? 0) >= since
  );
}

/** 现在是否到了该执行的时间 */
export function isDue(cfg: StrmConfig, state: StrmAutoState, now: Date = new Date()): boolean {
  if (!cfg.autoCheck) return false;

  if (cfg.autoCheckMode === 'interval') {
    const last = state.lastRunAt ?? 0;
    // 从未跑过：先等一个间隔，避免刚打开开关就突然全量扫一遍
    if (!last) return false;
    return now.getTime() - last >= cfg.autoCheckEveryHours * 60 * 60 * 1000;
  }

  const planned = plannedAt(now, cfg.autoCheckAt);
  const diff = now.getTime() - planned.getTime();
  // 还没到点，或已经错过太久（超过补跑窗口）→ 不做
  if (diff < 0 || diff > CATCH_UP_MS) return false;
  // 当天这个时段已经跑过
  if (state.lastSlot === slotKey(planned, cfg.autoCheckAt)) return false;
  // 多天间隔：距上次执行日期不足 N 天就跳过
  if (cfg.autoCheckEveryDays > 1 && state.lastRunAt) {
    const days = Math.floor(
      (startOfDay(now).getTime() - startOfDay(new Date(state.lastRunAt)).getTime()) / DAY_MS
    );
    if (days < cfg.autoCheckEveryDays) return false;
  }
  // 手动全量检查过就不必再来一遍
  return !manualCheckedToday(now);
}

/** 下一次自动检查的时间戳；未开启返回 null */
export function nextRunAt(cfg: StrmConfig, now: Date = new Date()): number | null {
  if (!cfg.autoCheck) return null;
  const state = getAutoState();

  if (cfg.autoCheckMode === 'interval') {
    const interval = cfg.autoCheckEveryHours * 60 * 60 * 1000;
    const last = state.lastRunAt;
    if (!last) return now.getTime() + interval;
    const next = last + interval;
    return next > now.getTime() ? next : now.getTime() + 60_000;
  }

  // daily：从今天起找第一个「满足天间隔且时刻未过」的日子
  const base = startOfDay(now);
  const lastRun = state.lastRunAt;
  for (let i = 0; i <= cfg.autoCheckEveryDays + 1; i += 1) {
    const day = new Date(base.getTime() + i * DAY_MS);
    const planned = plannedAt(day, cfg.autoCheckAt);
    if (planned.getTime() <= now.getTime()) continue;
    if (cfg.autoCheckEveryDays > 1 && lastRun) {
      const days = Math.floor(
        (startOfDay(day).getTime() - startOfDay(new Date(lastRun)).getTime()) / DAY_MS
      );
      if (days < cfg.autoCheckEveryDays) continue;
    }
    return planned.getTime();
  }
  return null;
}

/* ── 执行 ── */

function toStats(job: StrmJob): StrmAutoStats {
  return {
    scanned: job.total,
    ok: job.ok,
    fixed: job.fixed,
    deepFixed: job.deepFixed,
    unfixable: job.fail,
    verifyFailed: job.verifyFailed,
    truncated: false,
  };
}

/** 作业结束后把结果写进 auto.json（面板展示「上次执行」） */
function recordJobResult(job: StrmJob): void {
  const failed = job.status === 'failed';
  const partial = job.status === 'canceled' || job.status === 'paused';
  saveAutoState({
    ...getAutoState(),
    lastFinishedAt: Date.now(),
    lastResult: failed
      ? `执行失败：${job.note ?? '未知错误'}`
      : `${partial ? '未跑完：' : ''}${job.note ?? `完成 ${job.done}/${job.total}`}`,
    lastStats: toStats(job),
    lastError: failed ? (job.note ?? '执行失败') : undefined,
  });
}

// 任何来源的检查作业结束都记一笔：手动、定时、暂停后继续都能反映到「上次执行」。
// 用回调注册而不是直接 import，避免 auto ↔ jobs 形成循环依赖。
onJobFinished(recordJobResult);

export interface AutoRunResult {
  ok: boolean;
  reason: string;
  /** 本次是否真的开始了检查（false 表示被跳过或复用） */
  started: boolean;
  jobId?: string;
  /** 复用了已有的作业 */
  reused?: boolean;
}

/**
 * 立即执行一次自动检查（定时到点与用户点「立即执行」走同一条路）。
 * 创建后台作业后立刻返回，进度通过 autoSummary() / 作业接口读取。
 */
export async function runAutoCheck(opts?: { manual?: boolean }): Promise<AutoRunResult> {
  const cfg = getStrmConfig();
  if (!opts?.manual && !cfg.autoCheck) {
    return { ok: false, reason: '未开启自动检查', started: false };
  }

  const active = findActiveJob();
  if (active) {
    return {
      ok: true,
      reason: '已有检查作业在进行，直接查看进度即可',
      started: false,
      jobId: active.id,
      reused: true,
    };
  }

  let files: string[] = [];
  try {
    files = (await collectStrmFiles(cfg.outputDir)).files;
  } catch {
    files = [];
  }

  const { job, reused } = createJob(files, {
    trigger: opts?.manual ? 'manual' : 'auto',
    repair: true,
    // 定时任务先实拉验证（verify）才能发现地址失效，再按 autoFix 决定是否回源重取
    verify: true,
    deep: cfg.autoFix,
  });

  // 先占位：同一天的手动执行也算「今天已检查」，
  // 避免点完「立即检查」紧接的定时 tick 又跑一遍
  const now = new Date();
  const state = getAutoState();
  saveAutoState({
    ...state,
    lastRunAt: now.getTime(),
    lastResult: cfg.autoFix ? '检查已开始，失效项将自动回源修复…' : '检查已开始…',
    lastError: undefined,
    lastSlot: cfg.autoCheckMode === 'daily' ? slotKey(now, cfg.autoCheckAt) : state.lastSlot,
  });

  if (!reused) void startJob(job);
  return {
    ok: true,
    reason: reused ? '已有检查作业在进行，直接查看进度即可' : '已开始检查',
    started: !reused,
    jobId: job.id,
    reused,
  };
}

/**
 * 调度器每分钟调用一次：到点且当天没跑过就执行。
 * 幂等：同一时段重复调用不会重复创建作业。
 */
export async function autoTick(now: Date = new Date()): Promise<'idle' | 'started' | 'skipped'> {
  const cfg = getStrmConfig();
  if (!cfg.autoCheck) return 'idle';
  if (!isDue(cfg, getAutoState(), now)) return 'idle';

  const r = await runAutoCheck();
  if (r.started) {
    const label =
      cfg.autoCheckMode === 'daily'
        ? `${cfg.autoCheckEveryDays > 1 ? `每 ${cfg.autoCheckEveryDays} 天 ` : '每天 '}${cfg.autoCheckAt}`
        : `每 ${cfg.autoCheckEveryHours} 小时`;
    console.log(`[strm-auto] 定时检查已触发（${label}）`);
    return 'started';
  }
  return 'skipped';
}

/** 设置页展示用：把配置与状态合成一条摘要 */
export function autoSummary(now: Date = new Date()): StrmAutoSummary {
  const cfg = getStrmConfig();
  const state = getAutoState();
  const active = findActiveJob();

  let nextAt = nextRunAt(cfg, now);
  // 已到期但还没跑（等下一次 tick）：显示一分钟后
  if (cfg.autoCheck && !active && isDue(cfg, state, now)) nextAt = now.getTime() + 60_000;

  return {
    enabled: cfg.autoCheck,
    mode: cfg.autoCheckMode,
    at: cfg.autoCheckAt,
    everyDays: cfg.autoCheckEveryDays,
    everyHours: cfg.autoCheckEveryHours,
    fix: cfg.autoFix,
    nextAt,
    activeJob: active
      ? {
          id: active.id,
          trigger: active.trigger,
          done: active.done,
          total: active.total,
          startedAt: active.startedAt,
          current: active.current,
        }
      : undefined,
    lastRunAt: state.lastRunAt,
    lastFinishedAt: state.lastFinishedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    lastStats: state.lastStats,
  };
}

/** 测试用：清空落盘状态 */
export function __resetStrmAutoForTest(): void {
  try {
    fs.rmSync(statePath(), { force: true });
  } catch {
    /* 忽略 */
  }
}
