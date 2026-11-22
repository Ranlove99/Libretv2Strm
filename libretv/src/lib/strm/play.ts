import { fetchUpstreamWithMeta } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { signStrmUrl, verifyStrmUrl } from './sign';

/**
 * STRM 播放代理：媒体服务器（Emby/Jellyfin/Infuse/Kodi/VLC）直接请求本端点。
 *
 * - 鉴权用 HMAC 签名 URL（播放器带不了浏览器 cookie，无法走会话鉴权）；
 * - m3u8 响应做服务端重写：分片/密钥/初始化段地址全部改写为带签名的代理地址，
 *   播放器只需面对本站一个域名，防盗链（UA/Referer）由服务端统一处理；
 * - 非 m3u8 内容（ts 分片、mp4 直链）流式透传，Range 头透传支持拖动。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 把 m3u8 内的 URI 改写为本站签名代理地址（相对地址基于 base 解析） */
export function rewriteM3u8(text: string, base: URL): string {
  const wrap = (uri: string): string => {
    let abs: string;
    try {
      abs = new URL(uri, base).toString();
    } catch {
      return uri;
    }
    return `/api/strm/play?u=${encodeURIComponent(abs)}&sig=${signStrmUrl(abs)}`;
  };
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // #EXT-X-KEY:URI="..." / #EXT-X-MAP:URI="..." 等属性里的地址
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${wrap(uri)}"`);
      }
      return wrap(trimmed);
    })
    .join('\n');
}

/** 判断响应是否应按 m3u8 处理 */
function looksLikeM3u8(contentType: string, url: string): boolean {
  return (
    /mpegurl|vnd\.apple\.mpegurl|x-mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(url)
  );
}

/** 处理 /api/strm/play 请求 */
export async function handleStrmPlay(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const target = sp.get('u');
  const sig = sp.get('sig');

  if (!target || !/^https?:\/\//.test(target)) {
    return new Response('缺少或非法的播放地址', { status: 400 });
  }
  if (!verifyStrmUrl(target, sig)) {
    return new Response('播放地址签名无效', { status: 403 });
  }
  const verdict = await checkUpstreamAllowed(target);
  if (!verdict.ok) {
    return new Response(verdict.reason, { status: 400 });
  }

  let origin = '';
  try {
    origin = new URL(target).origin;
  } catch {
    return new Response('播放地址解析失败', { status: 400 });
  }

  // 手动逐跳跟随由 fetchUpstreamWithMeta 内部处理（safeRedirects 默认开启），
  // 分片相对地址基于最终 URL 解析。
  // retries：采集站 CDN 偶发 ECONNRESET（反爬限流），播放器不一定重试，
  // 服务端对连接级错误自动重试，保证媒体库连续播放体验。
  const range = req.headers.get('range');
  let upstream: Response;
  let finalUrl = target;
  try {
    const result = await fetchUpstreamWithMeta(target, {
      timeoutMs: 15000,
      retries: 2,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Referer: origin + '/',
        ...(range ? { Range: range } : {}),
      },
    });
    upstream = result.res;
    finalUrl = result.finalUrl || target;
  } catch (err) {
    return new Response(`上游请求失败：${err instanceof Error ? err.message : '未知错误'}`, {
      status: 502,
    });
  }

  const contentType = upstream.headers.get('content-type') || '';

  if (looksLikeM3u8(contentType, target)) {
    let text: string;
    try {
      text = await upstream.text();
    } catch {
      return new Response('播放列表读取失败', { status: 502 });
    }
    // 空响应/错误页不是有效 m3u8
    if (!text.includes('#EXTM3U')) {
      return new Response('上游返回的不是有效的播放列表', { status: 502 });
    }
    const rewritten = rewriteM3u8(text, new URL(finalUrl));
    return new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // 透传：分片/直链视频
  const headers = new Headers();
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
  for (const h of passthrough) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
