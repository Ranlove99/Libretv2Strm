import crypto from 'node:crypto';

/**
 * STRM 播放地址签名：媒体服务器（Emby/Jellyfin/Infuse）无法携带浏览器会话 cookie，
 * 播放端点不能走会话鉴权；改用 HMAC 签名 URL 作为长期凭证。
 * secret 与鉴权模块同源（PROXY_SECRET 优先，否则由 PASSWORD 派生），仅盐值不同。
 */

function getSecret(): string {
  if (process.env.PROXY_SECRET) return process.env.PROXY_SECRET;
  return crypto
    .createHash('sha256')
    .update((process.env.PASSWORD || '') + ':libretv::strm-salt')
    .digest('hex');
}

/** 对播放地址签名（hex） */
export function signStrmUrl(url: string): string {
  return crypto.createHmac('sha256', getSecret()).update(url).digest('hex');
}

/** 恒定时间比较签名，非法输入一律 false */
export function verifyStrmUrl(url: string, sig: string | null): boolean {
  if (!sig || !url) return false;
  const expected = Buffer.from(signStrmUrl(url));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/** 构造经本站代理的播放地址（供 strm 文件内容使用） */
export function buildProxyPlayUrl(publicBaseUrl: string, url: string): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return `${base}/api/strm/play?u=${encodeURIComponent(url)}&sig=${signStrmUrl(url)}`;
}
