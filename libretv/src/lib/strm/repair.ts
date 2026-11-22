import fs from 'node:fs';
import path from 'node:path';
import { isRelayHost, lanBaseUrls, lanIpv4, resolveStrmBaseUrl } from './base-url';
import { fetchVodDetail } from './cms-catalog';
import { strmContent } from './generator';
import { signStrmUrl, verifyStrmUrl } from './sign';
import { verifyStrmFile } from './verify';
import type {
  StrmConfig,
  StrmIssueCode,
  StrmRepairDetail,
  StrmRepairResult,
  StrmTask,
  StrmVerifyStatus,
} from './types';

/**
 * 已生成 .strm 文件的「检查 + 修复」。
 *
 * 与 verify.ts 的区别：verify 只判断能不能播、把结果记在任务明细里；
 * 这里面向**磁盘上已经存在的媒体库**，能修的直接改文件，修不了的给出原因。
 *
 * 修复分两层：
 * 1. 结构修复（不联网，安全、无损）：
 *    - 去掉首尾空白 / BOM；
 *    - 代理地址指向 FN Connect 中继域名 → 改写为当前对外地址
 *      （中继只有已登录浏览器能过，媒体服务器必然 403，这是历史最大的坑）；
 *    - 代理地址指向已失效的旧局域网 IP → 改写为当前对外地址；
 *    - 签名缺失 / 与当前密钥不匹配（改过访问密码）→ 按当前密钥重算。
 * 2. 深度修复（联网，按任务记录回源重取）：
 *    - 文件地址验证失败时，用 tasks.json 里记录的 sourceUrl + vodId + 集序号
 *      重新拉详情，拿到新地址后按当前模式重写。源站换域名/换线路导致的失效可救。
 */

const DEFAULT_MAX_FILES = 3000;
const SCAN_MAX_DEPTH = 12;
const MAX_DETAILS = 300;
const DEFAULT_CONCURRENCY = 4;

/** RFC1918 局域网地址（不含 Tailscale 的 100.64/10 —— 那是可跨网访问的，不能当失效处理） */
const RFC1918_HOST = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export interface RepairContext {
  config: StrmConfig;
  /** 当前应写入 strm 的对外地址（已纠正中继域名，可能为空） */
  baseUrl: string;
  /**
   * baseUrl 是否来自用户显式配置（publicBaseUrl）。
   * 显式配置变了就按新地址改写；自动探测的局域网地址只在旧 IP 确实不属于本机时才改，
   * 避免多网卡 / 端口变化导致把仍可用的地址改坏。
   */
  explicitBase?: boolean;
}

export interface ContentFix {
  content: string;
  kind: 'direct' | 'proxy' | 'invalid';
  issues: StrmIssueCode[];
  /** 内容是否需要改写 */
  changed: boolean;
  /** 非空表示无法自动修复的原因 */
  unfixable?: string;
}

/**
 * 纯函数：诊断一份 strm 内容，并给出可写回的内容。
 * 不碰磁盘，便于单测；`ctx.baseUrl` 为空表示当前未配置可用对外地址。
 */
export function diagnoseStrmContent(raw: string, ctx: RepairContext): ContentFix {
  const issues: StrmIssueCode[] = [];
  const trimmed = raw.replace(/^\uFEFF/, '').trim();

  if (!trimmed) {
    return { content: '', kind: 'invalid', issues: ['empty'], changed: trimmed !== raw, unfixable: '文件为空' };
  }
  if (trimmed !== raw) issues.push('whitespace');
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      content: trimmed,
      kind: 'invalid',
      issues: [...issues, 'not-url'],
      changed: trimmed !== raw,
      unfixable: '内容不是 http(s) 播放地址',
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      content: trimmed,
      kind: 'invalid',
      issues: [...issues, 'not-url'],
      changed: trimmed !== raw,
      unfixable: '播放地址无法解析',
    };
  }

  const isProxy = url.pathname.includes('/api/strm/play');

  // —— 直链 ——
  if (!isProxy) {
    if (isRelayHost(url.hostname)) {
      issues.push('direct-relay-host');
      return {
        content: trimmed,
        kind: 'direct',
        issues,
        changed: trimmed !== raw,
        unfixable: '直链指向 FN Connect 中继域名，媒体服务器无法访问；需重新生成或深度修复',
      };
    }
    return { content: trimmed, kind: 'direct', issues, changed: trimmed !== raw };
  }

  // —— 代理地址 ——
  const target = url.searchParams.get('u');
  const sig = url.searchParams.get('sig');
  if (!target || !/^https?:\/\//i.test(target)) {
    issues.push('proxy-bad-target');
    return {
      content: trimmed,
      kind: 'proxy',
      issues,
      changed: trimmed !== raw,
      unfixable: '代理地址缺少有效的上游播放目标',
    };
  }

  const oldBase = `${url.protocol}//${url.host}`;
  const currentBase = ctx.baseUrl.replace(/\/+$/, '');
  let newBase = oldBase;

  if (isRelayHost(url.hostname)) {
    issues.push('proxy-relay-base');
    if (!currentBase) {
      return {
        content: trimmed,
        kind: 'proxy',
        issues,
        changed: trimmed !== raw,
        unfixable: '原地址是 FN Connect 中继域名，且当前没有可用的对外地址',
      };
    }
    newBase = currentBase;
  } else if (currentBase && oldBase.toLowerCase() !== currentBase.toLowerCase() && RFC1918_HOST.test(url.hostname)) {
    // 旧局域网 IP：显式配置变了，或该 IP 已不属于本机（NAS 换过 IP）才改写；
    // 仅仅端口/网卡顺序不同时不动，避免把仍可用的地址改坏
    const staleIp = !lanIpv4().includes(url.hostname);
    if (ctx.explicitBase || staleIp) {
      issues.push('proxy-stale-lan-base');
      newBase = currentBase;
    }
  }

  const sigOk = !!sig && verifyStrmUrl(target, sig);
  if (!sig) issues.push('proxy-missing-sig');
  else if (!sigOk) issues.push('proxy-bad-sig');

  if (newBase === oldBase && sigOk) {
    return { content: trimmed, kind: 'proxy', issues, changed: trimmed !== raw };
  }

  const content = `${newBase}/api/strm/play?u=${encodeURIComponent(target)}&sig=${signStrmUrl(target)}`;
  return { content, kind: 'proxy', issues, changed: content !== raw };
}

/** 递归收集输出目录下的 .strm 相对路径（跳过隐藏目录，带数量上限） */
export async function collectStrmFiles(
  root: string,
  maxFiles = DEFAULT_MAX_FILES
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > SCAN_MAX_DEPTH) return;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (truncated) return;
      if (d.name.startsWith('.')) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (d.isFile() && d.name.toLowerCase().endsWith('.strm')) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };

  await walk(path.resolve(root), 0);
  return { files, truncated };
}

/** 一个文件在任务历史里的来源，用于深度修复时回源重取 */
export interface StrmFileOrigin {
  taskId: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  vodId: string;
  episodeIndex: number;
  episodeName: string;
}

/**
 * 由任务历史建立「文件路径 → 来源」索引。
 * 传入的 tasks 应按新到旧排列；同一文件只保留最新一条（先入为主）。
 */
export function buildOriginIndex(tasks: StrmTask[]): Map<string, StrmFileOrigin> {
  const map = new Map<string, StrmFileOrigin>();
  for (const task of tasks) {
    for (const item of task.items) {
      item.episodes.forEach((ep, index) => {
        if (!ep.file || map.has(ep.file)) return;
        map.set(ep.file, {
          taskId: task.id,
          sourceKey: item.sourceKey,
          sourceName: item.sourceName,
          sourceUrl: item.sourceUrl,
          vodId: item.vodId,
          episodeIndex: index,
          episodeName: ep.name,
        });
      });
    }
  }
  return map;
}

/** 原子写回：tmp + rename，避免媒体服务器读到半截内容 */
async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.repair-${process.pid}-${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, abs);
}

/** 深度修复单个文件：回源拉详情，按集序号/集名匹配新地址后重写 */
async function deepRepairFile(
  abs: string,
  origin: StrmFileOrigin,
  ctx: RepairContext,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  const detail = await fetchVodDetail(
    { key: origin.sourceKey, name: origin.sourceName, url: origin.sourceUrl },
    origin.vodId,
    signal
  );
  const ep = detail.episodes[origin.episodeIndex] ?? detail.episodes.find((e) => e.name === origin.episodeName);
  if (!ep) return { ok: false, error: '源站已无该集' };
  await atomicWrite(abs, strmContent(ep.url, ctx.config, ctx.baseUrl));
  return { ok: true };
}

export interface CheckRepairOptions {
  /** 做结构修复（false = 只读检查） */
  repair?: boolean;
  /** 对失效文件回源重取（联网，慢） */
  deep?: boolean;
  /** 修复后验证可播放性（联网，慢） */
  verify?: boolean;
  maxFiles?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

/**
 * 检查（并可选修复）输出目录里的全部 .strm。
 * 返回汇总 + 有问题的文件明细，供界面展示。
 */
export async function checkAndRepairStrm(
  config: StrmConfig,
  tasks: StrmTask[],
  options: CheckRepairOptions = {}
): Promise<StrmRepairResult> {
  const root = path.resolve(config.outputDir);
  const resolved = resolveStrmBaseUrl(config.publicBaseUrl);
  // 代理文件需要对外地址；配置为空时退回本机局域网地址（媒体服务器通常同局域网）
  const baseUrl = resolved.baseUrl || lanBaseUrls()[0] || '';

  const { files, truncated } = await collectStrmFiles(root, options.maxFiles ?? DEFAULT_MAX_FILES);
  const originIndex = options.deep ? buildOriginIndex(tasks) : new Map<string, StrmFileOrigin>();
  const details: StrmRepairDetail[] = [];

  let ok = 0;
  let fixed = 0;
  let deepFixed = 0;
  let unfixable = 0;
  let pendingRepair = 0;
  let verifyFailed = 0;

  const ctx: RepairContext = { config, baseUrl, explicitBase: !!resolved.baseUrl };
  let cursor = 0;
  const concurrency = Math.min(8, Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY));

  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      if (options.signal?.aborted) return;
      const rel = files[cursor];
      cursor += 1;

      const abs = path.resolve(root, rel);
      // 防目录逃逸
      if (abs !== root && !abs.startsWith(root + path.sep)) continue;

      let raw: string;
      try {
        raw = await fs.promises.readFile(abs, 'utf8');
      } catch {
        unfixable += 1;
        details.push({ file: rel, kind: 'invalid', issues: ['unreadable'], reason: '文件读取失败' });
        continue;
      }

      const fix = diagnoseStrmContent(raw, ctx);
      let written = false;
      let deepApplied = false;
      let reason = fix.unfixable;

      if (fix.changed && !fix.unfixable && options.repair) {
        try {
          await atomicWrite(abs, fix.content);
          written = true;
        } catch (err) {
          reason = `写入失败：${err instanceof Error ? err.message : '未知错误'}`;
        }
      }

      // 验证（结构修复后再验，才反映修复效果）
      let verify: StrmVerifyStatus | undefined;
      let verifyError: string | undefined;
      if (options.verify && !fix.unfixable) {
        const vr = await verifyStrmFile(abs, options.signal);
        verify = vr.verify;
        verifyError = vr.verifyError;
      }

      // 深度修复：结构修不了，或验证失败时，按任务记录回源重取
      if (options.deep && (fix.unfixable || verify === 'fail')) {
        const origin = originIndex.get(rel);
        if (origin) {
          try {
            const dr = await deepRepairFile(abs, origin, ctx, options.signal);
            if (dr.ok) {
              deepApplied = true;
              reason = undefined;
              if (options.verify) {
                const vr2 = await verifyStrmFile(abs, options.signal);
                verify = vr2.verify;
                verifyError = vr2.verifyError;
              }
            } else {
              reason = dr.error || reason;
            }
          } catch (err) {
            reason = `深度修复失败：${err instanceof Error ? err.message : '未知错误'}`;
          }
        } else if (fix.unfixable && !reason) {
          reason = '任务记录里找不到该文件，无法回源重取';
        }
      }

      const stillBroken = !!fix.unfixable && !deepApplied;
      // 归类：每个文件只落入一个桶，避免「可修未改」又被算成「正常」
      if (deepApplied) deepFixed += 1;
      else if (stillBroken) unfixable += 1;
      else if (written) fixed += 1;
      else if (fix.changed && !options.repair) pendingRepair += 1;
      else if (fix.issues.length === 0) ok += 1;
      else unfixable += 1; // 可修但写入失败

      if (verify === 'fail') verifyFailed += 1;

      const hasIssue = fix.issues.length > 0 || !!fix.unfixable || deepApplied || verify === 'fail';
      if (hasIssue && details.length < MAX_DETAILS) {
        details.push({
          file: rel,
          kind: fix.kind,
          issues: fix.issues,
          fixed: written || undefined,
          deepFixed: deepApplied || undefined,
          reason,
          verify,
          verifyError,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  return {
    root,
    scanned: files.length,
    ok,
    fixed,
    deepFixed,
    unfixable,
    pendingRepair,
    verifyFailed,
    truncated,
    details,
  };
}
