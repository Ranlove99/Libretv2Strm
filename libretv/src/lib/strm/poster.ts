import { fetchUpstream } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';

/**
 * 海报下载：采集站图片普遍有防盗链（Referer/UA 校验），
 * 由服务端带头请求后落盘 poster.jpg。失败静默返回 undefined，不阻塞 STRM 生成。
 */

const MAX_POSTER_BYTES = 5 * 1024 * 1024;

export async function downloadPoster(
  picUrl: string,
  signal?: AbortSignal
): Promise<Buffer | undefined> {
  if (!/^https?:\/\//.test(picUrl)) return undefined;
  try {
    const verdict = await checkUpstreamAllowed(picUrl);
    if (!verdict.ok) return undefined;
    let origin = '';
    try {
      origin = new URL(picUrl).origin;
    } catch {
      return undefined;
    }
    const res = await fetchUpstream(picUrl, {
      timeoutMs: 8000,
      signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: origin + '/',
      },
    });
    if (!res.ok) return undefined;
    const contentType = res.headers.get('content-type') || '';
    if (contentType && !contentType.startsWith('image/')) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_POSTER_BYTES) return undefined;
    // 简单魔数校验：JPEG / PNG / WebP / GIF
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isWebp = buf.length > 12 && buf.toString('utf8', 8, 12) === 'WEBP';
    const isGif = buf.toString('utf8', 0, 3) === 'GIF';
    if (!isJpeg && !isPng && !isWebp && !isGif) return undefined;
    return buf;
  } catch {
    return undefined;
  }
}
