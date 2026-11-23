import fs from 'node:fs';
import path from 'node:path';
import { getStrmConfig, ensureOutputDir, strmDataRoot } from './config';
import { fetchVodDetail } from './cms-catalog';
import { planGeneration, writeGeneration } from './generator';
import { downloadPoster } from './poster';
import { verifyItemEpisodes } from './verify';
import { recordSourceResult } from './source-stats';
import { resolveStrmBaseUrl } from './base-url';
import type { StrmConfig, StrmTask, StrmTaskItem } from './types';

/**
 * STRM 生成任务引擎：内存任务表 + tasks.json 持久化 + 单任务串行队列。
 *
 * 设计取舍：
 * - 同时只跑一个任务（任务内影片按 concurrency 并发）：采集站对并发敏感，
 *   且 NAS 上同时写几百个 strm 文件没有收益；
 * - 任务持久化保证重启后可查历史；重启时处于 running/queued 的任务标记为
 *   failed（服务重启导致中断），用户可一键重试；
 * - 写盘用 tmp + rename 原子替换，避免半截 JSON 损坏任务表。
 */

const MAX_TASKS = 100;
const PERSIST_DEBOUNCE_MS = 400;

function tasksFilePath(): string {
  return path.join(strmDataRoot(), 'tasks.json');
}

let tasks: StrmTask[] = [];
let loaded = false;
/** 任务 id → AbortController（仅 running 任务有） */
const controllers = new Map<string, AbortController>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistDirty = false;

// —— 持久化 ——

function loadTasks(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(tasksFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { tasks?: StrmTask[] };
    if (Array.isArray(parsed.tasks)) {
      tasks = parsed.tasks.map((t) => {
        // 重启中断：进行中/排队中的任务标记失败，保留明细供重试
        if (t.status === 'running' || t.status === 'queued') {
          t.status = 'failed';
          t.finishedAt = Date.now();
          for (const item of t.items) {
            if (item.status === 'running' || item.status === 'pending') {
              item.status = 'failed';
              item.error = item.error || '服务重启，任务中断';
            }
          }
          t.failed = t.items.filter((i) => i.status === 'failed').length;
          t.done = t.items.filter((i) => i.status === 'done').length;
        }
        return t;
      });
    }
  } catch {
    tasks = [];
  }
}

function persistNow(): void {
  persistTimer = undefined;
  if (!persistDirty) return;
  persistDirty = false;
  try {
    fs.mkdirSync(strmDataRoot(), { recursive: true });
    const tmp = tasksFilePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks }, null, 2));
    fs.renameSync(tmp, tasksFilePath());
  } catch (err) {
    console.warn('[LibreTV][strm] 任务持久化失败：', err instanceof Error ? err.message : err);
  }
}

function persist(): void {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
}

// —— 查询 ——

export function listTasks(): StrmTask[] {
  loadTasks();
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

export function getTask(id: string): StrmTask | undefined {
  loadTasks();
  return tasks.find((t) => t.id === id);
}

export interface CreateTaskInput {
  title?: string;
  baseUrl?: string;
  /** 地址被自动纠正时的提示（写入任务，界面可见） */
  warning?: string;
  items: Array<{
    sourceKey: string;
    sourceName: string;
    sourceUrl: string;
    vodId: string;
    title: string;
    year?: string;
    typeName?: string;
  }>;
}

/** 创建任务并入队；重复影片（同源同 id 且未完成）自动跳过 */
export function createTask(input: CreateTaskInput): StrmTask {
  loadTasks();
  const now = Date.now();
  const taskItems: StrmTaskItem[] = [];
  const seen = new Set<string>();
  for (const it of input.items.slice(0, 200)) {
    const key = `${it.sourceUrl.replace(/\/+$/, '')}|${it.vodId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    taskItems.push({
      sourceKey: it.sourceKey,
      sourceName: it.sourceName,
      sourceUrl: it.sourceUrl,
      vodId: it.vodId,
      title: it.title,
      year: it.year,
      typeName: it.typeName,
      status: 'pending',
      episodes: [],
    });
  }
  const task: StrmTask = {
    id: `t_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: input.title?.trim().slice(0, 120) || `STRM 生成任务（${taskItems.length} 部）`,
    status: 'queued',
    total: taskItems.length,
    done: 0,
    failed: 0,
    items: taskItems,
    createdAt: now,
    baseUrl: input.baseUrl,
    warning: input.warning,
  };
  tasks = [task, ...tasks].slice(0, MAX_TASKS);
  persist();
  void kick();
  return task;
}

export function cancelTask(id: string): boolean {
  loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return false;
  const controller = controllers.get(id);
  if (controller) {
    controller.abort();
    return true;
  }
  // queued：直接标记
  if (task.status === 'queued') {
    task.status = 'canceled';
    task.finishedAt = Date.now();
    persist();
    return true;
  }
  return false;
}

export function deleteTask(id: string): boolean {
  loadTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  if (tasks[idx].status === 'running') return false;
  tasks.splice(idx, 1);
  persistNow();
  return true;
}

/** 重试：失败/未处理影片重置为 pending，任务重新入队 */
export function retryTask(id: string): boolean {
  loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return false;
  if (task.status === 'running') return false;
  for (const item of task.items) {
    if (item.status !== 'done') {
      item.status = 'pending';
      item.error = undefined;
      item.episodes = [];
    }
  }
  task.status = 'queued';
  task.finishedAt = undefined;
  task.done = task.items.filter((i) => i.status === 'done').length;
  task.failed = 0;
  persist();
  void kick();
  return true;
}

// —— 执行 ——

let running = false;

function kick(): void {
  if (running) return;
  const next = listTasks().find((t) => t.status === 'queued');
  if (!next) return;
  void runTask(next);
}

async function processItem(
  item: StrmTaskItem,
  config: StrmConfig,
  baseUrl: string,
  signal: AbortSignal
): Promise<void> {
  item.status = 'running';
  try {
    const detail = await fetchVodDetail(
      { key: item.sourceKey, name: item.sourceName, url: item.sourceUrl },
      item.vodId,
      signal
    );
    if (config.maxEpisodes > 0 && detail.episodes.length > config.maxEpisodes) {
      detail.episodes = detail.episodes.slice(0, config.maxEpisodes);
    }
    if (detail.episodes.length === 0) throw new Error('未找到播放资源');

    const plan = planGeneration(detail, config);
    const poster =
      config.downloadPoster && detail.pic ? await downloadPoster(detail.pic, signal) : undefined;
    await writeGeneration(plan, detail, config, config.outputDir, baseUrl, poster);

    item.episodes = plan.episodes.map((e) => ({ name: e.name, file: e.file }));
    item.status = 'done';

    // 有效性测试（开关控制）：逐集实际请求播放地址，结果写入明细
    if (config.verifyAfterGenerate) {
      await verifyItemEpisodes(item.episodes, config.outputDir, signal);
      // 源评分：成功逐集计；失败整部片只计一次——
      // 一部片后面几集失效很常见，逐集计会把好源砸成差源
      for (const ep of item.episodes) {
        if (ep.verify === 'ok') {
          recordSourceResult({ url: item.sourceUrl, name: item.sourceName, ok: true });
        }
      }
      if (item.episodes.some((ep) => ep.verify === 'fail')) {
        recordSourceResult({ url: item.sourceUrl, name: item.sourceName, ok: false });
      }
    }
  } catch (err) {
    if (signal.aborted) {
      item.status = 'failed';
      item.error = '已取消';
    } else {
      item.status = 'failed';
      item.error = err instanceof Error ? err.message : '生成失败';
    }
  }
}

async function runTask(task: StrmTask): Promise<void> {
  running = true;
  const controller = new AbortController();
  controllers.set(task.id, controller);
  const config = getStrmConfig();
  // 兜底再纠正一次：配置里的对外地址可能是在中继域名下保存的（历史数据）
  const resolvedBase = resolveStrmBaseUrl(config.publicBaseUrl || task.baseUrl || '');
  const baseUrl = resolvedBase.baseUrl;
  if (resolvedBase.warning) {
    task.warning = resolvedBase.warning;
    console.warn('[LibreTV][strm]', resolvedBase.warning);
  }

  try {
    // 输出目录校验尽早失败（权限/非法路径）
    ensureOutputDir(config.outputDir);
  } catch (err) {
    task.status = 'failed';
    task.finishedAt = Date.now();
    task.failed = task.total;
    for (const item of task.items) {
      if (item.status !== 'done') {
        item.status = 'failed';
        item.error = err instanceof Error ? err.message : '输出目录不可用';
      }
    }
    controllers.delete(task.id);
    persist();
    running = false;
    kick();
    return;
  }

  task.status = 'running';
  task.finishedAt = undefined;
  persist();

  const concurrency = Math.max(1, config.concurrency);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < task.items.length) {
      if (controller.signal.aborted) return;
      const item = task.items[cursor];
      cursor += 1;
      if (item.status === 'done') continue;
      await processItem(item, config, baseUrl, controller.signal);
      task.done = task.items.filter((i) => i.status === 'done').length;
      task.failed = task.items.filter((i) => i.status === 'failed').length;
      persist();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const aborted = controller.signal.aborted;
  task.status = aborted ? 'canceled' : task.failed > 0 && task.done === 0 ? 'failed' : 'done';
  task.finishedAt = Date.now();
  controllers.delete(task.id);
  persist();
  running = false;
  kick();
}

/** 测试辅助：重置内存态（不删磁盘文件） */
export function __resetStrmTaskEngineForTest(): void {
  tasks = [];
  loaded = true;
  controllers.clear();
  running = false;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = undefined;
  persistDirty = false;
}
