import fs from 'node:fs';
import path from 'node:path';
import { isRelayHost, listenPort } from './base-url';
import type { StrmTaskEpisode, StrmVerifyStatus } from './types';

/**
 * STRM 有效性测试：读取已生成的 .strm 文件内容作为播放地址，
 * 实际请求验证能否拉到可用流。
 *
 * - m3u8（代理/直链）：要求 200 且内容含 #EXTM3U；
 * - mp4/ts 等直链：HTTP 200 即认为有效（立即断开不拉完整内容）。
 * - 验证目标是本站签名代理地址或采集站直链，不走 SSRF 预检
 *   （地址均由本应用生成，且本站代理地址可能落在内网网段）。
 *
 * 修复：增加重试机制（CDN 偶发 ECONNRESET）；自动将 NAS 外网 IP 替换
 * 为 127.0.0.1（验证在本机执行，避免防火墙/路由回环问题）。
 */

export interface StrmVerifyResult {
  verify: StrmVerifyStatus;
  verifyError?: string;
}

const VERIFY_TIMEOUT_MS = 20000;
const VERIFY_CONCURRENCY = 3;
const VERIFY_MAX_RETRIES = 2;

/**
 * 将 strm 中的代理地址标准化为本地回环地址。
 * 问题：生成时 baseUrl 可能是 http://192.168.1.100:8099 或 https://relay.xxx/api/strm/play，
 * 验证时服务端 fetch 该地址可能被 NAS 防火墙阻止、DNS 回环失败，或因 HTTPS+127.0.0.1
 * 导致 SSL 握手失败（中继模式）。
 * 解决：检测到指向本机的代理地址时，统一替换为 http://127.0.0.1:<本机端口>。
 *
 * 修复（2.21.2）：原实现改 hostname/protocol 后丢掉了端口 ——
 * https 中继地址默认 443、改协议为 http 后落到 80 端口，验证必然 ECONNREFUSED，
 * 于是「中继模式下生成出来的 strm 全部验证失败」。现显式保留原端口，
 * 原地址无端口时回落到本机监听端口（fnOS 包为 8099）。
 */

/** 指向本机/内网的地址特征（这些地址改走回环才有意义） */
const LOCAL_HOST =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export function normalizeVerifyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.pathname.includes('/api/strm/play')) return url;
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return url;
    const localish =
      LOCAL_HOST.test(u.hostname) || isRelayHost(u.hostname) || u.hostname.endsWith('.local');
    // 真正的公网域名（用户自建反代）：保持原地址，避免把可用地址改坏
    if (!localish) return url;
    // 关键：端口必须保留，否则回环验证会打到 80 端口
    const port = u.port || String(listenPort());
    return `http://127.0.0.1:${port}${u.pathname}${u.search}`;
  } catch {
    // URL 解析失败返回原值
  }
  return url;
}

export async function verifyStrmFile(absPath: string, signal?: AbortSignal): Promise<StrmVerifyResult> {
  let url: string;
  try {
    url = (await fs.promises.readFile(absPath, 'utf8')).trim();
  } catch {
    return { verify: 'fail', verifyError: '文件读取失败' };
  }
  if (!/^https?:\/\//.test(url)) {
    return { verify: 'fail', verifyError: '播放地址无效' };
  }

  // 本地验证时将外网 IP 代理地址替换为回环地址
  url = normalizeVerifyUrl(url);

  let lastError: string | undefined;
  for (let attempt = 0; attempt <= VERIFY_MAX_RETRIES; attempt++) {
    if (signal?.aborted) return { verify: 'skipped' };
    if (attempt > 0) {
      // 重试前等待指数退避
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      const timeout = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: '*/*',
        },
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue; // 重试（可能临时 502/503）
      }
      const contentType = res.headers.get('content-type') || '';
      const looksLikeM3u8 =
        /mpegurl|x-mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(url);
      if (looksLikeM3u8) {
        const text = await res.text();
        if (!text.includes('#EXTM3U')) {
          lastError = '播放列表无效（无 #EXTM3U 标记）';
          continue;
        }
        return { verify: 'ok' };
      }
      // mp4/ts 等直链：状态 200 即有效，立即释放连接
      await res.body?.cancel();
      return { verify: 'ok' };
    } catch (err) {
      if (signal?.aborted) return { verify: 'skipped' };
      lastError = err instanceof Error ? err.message : '请求失败';
      // ECONNRESET / ETIMEDOUT 等网络错误值得重试
      if (attempt < VERIFY_MAX_RETRIES) continue;
    }
  }
  return { verify: 'fail', verifyError: lastError || '验证失败' };
}

/** 对一个影片的全部已生成集数做并发受限的有效性测试（直接更新 episode 字段） */
export async function verifyItemEpisodes(
  episodes: StrmTaskEpisode[],
  outputDir: string,
  signal?: AbortSignal
): Promise<void> {
  const root = path.resolve(outputDir);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < episodes.length) {
      if (signal?.aborted) return;
      const ep = episodes[cursor];
      cursor += 1;
      if (!ep.file) {
        ep.verify = 'skipped';
        continue;
      }
      const abs = path.resolve(root, ep.file);
      // 防目录逃逸：file 必须位于输出目录内
      if (!abs.startsWith(root + path.sep) && abs !== root) {
        ep.verify = 'skipped';
        continue;
      }
      const r = await verifyStrmFile(abs, signal);
      ep.verify = r.verify;
      ep.verifyError = r.verifyError;
    }
  };
  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, worker));
}
