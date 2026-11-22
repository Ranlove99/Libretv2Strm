import { handleStrmPlay } from '@/lib/strm/play';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * STRM 播放代理。刻意不走 guardRequest：
 * 媒体服务器（Emby/Jellyfin/Infuse/Kodi/VLC）只认 strm 文件里的 URL，
 * 无法携带浏览器会话 cookie；改用 HMAC 签名 URL 鉴权（见 lib/strm/sign.ts）。
 */
export async function GET(req: Request) {
  return handleStrmPlay(req);
}
