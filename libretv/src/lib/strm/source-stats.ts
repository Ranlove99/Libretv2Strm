import fs from 'node:fs';
import path from 'node:path';
import { strmDataRoot } from './config';
import type { StrmSourceStatView } from './types';

/**
 * 数据源注册表 + 评分（sources.json 落盘）。
 *
 * 为什么在服务端维护：源列表原本只存在浏览器 IndexedDB（zustand + Dexie），
 * 服务端跑的检查 / 修复作业（定时任务尤其如此）根本拿不到它——
 * 深度修复只能死磕任务记录里的原始源，原始源一挂整批文件都「仍失效」。
 * 注册表由两路共同喂数据：
 *   1. 前端打开 STRM 页面时上报当前源列表（POST /api/strm/sources）；
 *   2. 生成任务 / 修复作业执行时，把实际用到的源自动登记。
 * 评分则在每次「拉详情 / 验证播放地址」的真实结果上累积：
 *   成功率为主、延迟为辅、连续失败重罚，算出一个 0–100 的分数供排序。
 */

const SOURCES_FILE = 'sources.json';
/** 单源采样窗口：超过后新旧样本各减半，让近期表现占主导 */
const MAX_SAMPLES = 120;
/** 注册表规模上限：订阅导入上限是 100 个点播源，这里留出余量 */
const MAX_SOURCES = 300;

interface StrmSourceStat {
  /** 归一化后的源接口地址（唯一键：trim + 去尾斜杠） */
  url: string;
  name: string;
  /** 采样窗口内的成功 / 失败次数 */
  ok: number;
  fail: number;
  /** 成功请求的耗时累计（毫秒），用于平均延迟 */
  okMsSum: number;
  lastOkAt?: number;
  lastFailAt?: number;
  /** 连续失败次数：一次成功即清零 */
  failStreak: number;
  updatedAt: number;
}

interface StoredSources {
  sources: StrmSourceStat[];
}

function sourcesPath(): string {
  return path.join(strmDataRoot(), SOURCES_FILE);
}

/* ------------------------------ 键归一化 ------------------------------ */

/** 源的唯一键：trim + 去尾斜杠。与订阅导入的 normalizeUrl 规则保持一致 */
export function sourceKeyOf(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/* ------------------------------ 存储 ------------------------------ */

interface SourceState {
  map: Map<string, StrmSourceStat> | null;
  saveTimer: ReturnType<typeof setTimeout> | undefined;
}

const STATE_KEY = '__LIBRETV_STRM_SOURCES__';

function state(): SourceState {
  const g = globalThis as unknown as Record<string, SourceState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { map: null, saveTimer: undefined };
  return g[STATE_KEY] as SourceState;
}

function loadMap(): Map<string, StrmSourceStat> {
  const s = state();
  if (s.map) return s.map;
  const map = new Map<string, StrmSourceStat>();
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcesPath(), 'utf8')) as StoredSources;
    if (Array.isArray(parsed.sources)) {
      for (const item of parsed.sources) {
        if (typeof item?.url === 'string' && item.url) map.set(item.url, item);
      }
    }
  } catch {
    // 首次运行或文件损坏：从空表开始，评分随使用重新累积
  }
  s.map = map;
  return map;
}

function persistNow(): void {
  const s = state();
  s.saveTimer = undefined;
  if (!s.map) return;
  try {
    fs.mkdirSync(strmDataRoot(), { recursive: true });
    const list = [...s.map.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SOURCES);
    const tmp = `${sourcesPath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sources: list } satisfies StoredSources), 'utf8');
    fs.renameSync(tmp, sourcesPath());
  } catch {
    // 只读数据目录等情况：内存态依然可用，只是重启后评分丢失
  }
}

/** 节流落盘：评分变化很密，合并写入 */
function scheduleSave(): void {
  const s = state();
  if (s.saveTimer) return;
  s.saveTimer = setTimeout(persistNow, 1000);
  if (typeof s.saveTimer.unref === 'function') s.saveTimer.unref();
}

/** 立即落盘（测试 / 关键节点用） */
export function flushSources(): void {
  const s = state();
  if (s.saveTimer) {
    clearTimeout(s.saveTimer);
    s.saveTimer = undefined;
  }
  persistNow();
}

/* ------------------------------ 评分 ------------------------------ */

/** 冷启动分数：没有样本的源排在「验证过可用」之后、「验证过失效」之前 */
export const NEUTRAL_SCORE = 50;

/**
 * 单源评分（0–100，纯函数便于单测）：
 * - 成功率占 60 分（采样窗口内 ok / (ok + fail)）；
 * - 平均延迟占 25 分（10 秒以上不得分，越快越高）；
 * - 连续失败扣分：每次 -8，最多 -30（成功率对少量样本不够敏感）。
 */
export function scoreOf(stat: Pick<StrmSourceStat, 'ok' | 'fail' | 'okMsSum' | 'failStreak'>): number {
  const samples = stat.ok + stat.fail;
  if (samples === 0) return NEUTRAL_SCORE;
  const rate = stat.ok / samples;
  const avgMs = stat.ok > 0 ? stat.okMsSum / stat.ok : 0;
  const latency = Math.max(0, Math.min(1, 1 - avgMs / 10_000));
  const streakPenalty = Math.min(stat.failStreak, 4) * 8;
  const score = rate * 60 + latency * 25 - streakPenalty;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/* ------------------------------ 登记 ------------------------------ */

/**
 * 登记一批源（前端上报的当前源列表）：按 url upsert，只补名称，不动统计。
 * 前端源可能来自订阅 / 自定义 / 环境变量，url 是唯一身份。
 */
export function registerSources(list: Array<{ key?: string; name?: string; url: string }>): number {
  const map = loadMap();
  let added = 0;
  for (const item of list) {
    if (typeof item?.url !== 'string' || !/^https?:\/\//i.test(item.url)) continue;
    const key = sourceKeyOf(item.url);
    if (!key) continue;
    const existing = map.get(key);
    if (existing) {
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : existing.name;
      if (name !== existing.name) {
        existing.name = name;
        existing.updatedAt = Date.now();
        scheduleSave();
      }
      continue;
    }
    if (map.size >= MAX_SOURCES) break;
    map.set(key, {
      url: key,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 60) : key,
      ok: 0,
      fail: 0,
      okMsSum: 0,
      failStreak: 0,
      updatedAt: Date.now(),
    });
    added += 1;
  }
  if (added > 0) scheduleSave();
  return added;
}

export interface SourceProbeOutcome {
  url: string;
  name?: string;
  ok: boolean;
  /** 成功时的耗时（毫秒），用于平均延迟 */
  ms?: number;
}

/** 记录一次真实探测结果（拉详情 / 验证播放地址），评分随之更新 */
export function recordSourceResult(outcome: SourceProbeOutcome): void {
  const key = sourceKeyOf(outcome.url);
  if (!key) return;
  const map = loadMap();
  let stat = map.get(key);
  if (!stat) {
    if (map.size >= MAX_SOURCES) return;
    stat = {
      url: key,
      name: outcome.name?.trim().slice(0, 60) || key,
      ok: 0,
      fail: 0,
      okMsSum: 0,
      failStreak: 0,
      updatedAt: Date.now(),
    };
    map.set(key, stat);
  }
  if (outcome.ok) {
    stat.ok += 1;
    stat.failStreak = 0;
    stat.lastOkAt = Date.now();
    if (typeof outcome.ms === 'number' && Number.isFinite(outcome.ms) && outcome.ms >= 0) {
      stat.okMsSum += outcome.ms;
    }
  } else {
    stat.fail += 1;
    stat.failStreak += 1;
    stat.lastFailAt = Date.now();
  }
  // 采样窗口滚动：样本过多时新旧各减半，避免历史包袱压住近期表现
  if (stat.ok + stat.fail > MAX_SAMPLES) {
    stat.ok = Math.floor(stat.ok / 2);
    stat.fail = Math.floor(stat.fail / 2);
    stat.okMsSum = Math.floor(stat.okMsSum / 2);
  }
  stat.updatedAt = Date.now();
  scheduleSave();
}

/** 按 url 取源名（注册表里有就用，没有回落到 key） */
export function sourceNameOf(url: string): string | undefined {
  return loadMap().get(sourceKeyOf(url))?.name;
}

/* ------------------------------ 视图 ------------------------------ */

/** 评分视图（按分数降序）：设置页展示、跨源候选排序共用 */
export function sourceViews(): StrmSourceStatView[] {
  const map = loadMap();
  const views = [...map.values()].map((s) => {
    const samples = s.ok + s.fail;
    return {
      url: s.url,
      name: s.name,
      score: scoreOf(s),
      ok: s.ok,
      fail: s.fail,
      samples,
      successRate: samples > 0 ? Math.round((s.ok / samples) * 100) : undefined,
      avgMs: s.ok > 0 ? Math.round(s.okMsSum / s.ok) : undefined,
      failStreak: s.failStreak,
      lastOkAt: s.lastOkAt,
      lastFailAt: s.lastFailAt,
    } satisfies StrmSourceStatView;
  });
  return views.sort((a, b) => b.score - a.score || b.samples - a.samples);
}

/** 按评分降序取候选源（排除指定 url）：跨源替代修复的候选池 */
export function rankedCandidates(excludeUrl: string, limit: number): StrmSourceStatView[] {
  const exclude = sourceKeyOf(excludeUrl);
  return sourceViews()
    .filter((s) => s.url !== exclude && s.score > 0)
    .slice(0, Math.max(0, limit));
}

/** 测试辅助：清空内存态与磁盘文件 */
export function __resetStrmSourcesForTest(): void {
  const s = state();
  if (s.saveTimer) {
    clearTimeout(s.saveTimer);
    s.saveTimer = undefined;
  }
  s.map = null;
  try {
    fs.rmSync(sourcesPath(), { force: true });
  } catch {
    // 目录不存在等情况忽略
  }
}
