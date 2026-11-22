import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { createTask, listTasks, type CreateTaskInput } from '@/lib/strm/tasks';
import { getStrmConfig } from '@/lib/strm/config';
import { resolveStrmBaseUrl } from '@/lib/strm/base-url';

export const runtime = 'nodejs';

/** GET：任务列表（新的在前） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return NextResponse.json({ tasks: listTasks() });
}

/** POST：创建生成任务。items 来自搜索结果/目录浏览的多选结果 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let body: CreateTaskInput;
  try {
    body = (await req.json()) as CreateTaskInput;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: '请至少选择一部影片' }, { status: 400 });
  }
  for (const item of body.items) {
    if (!item || typeof item.vodId !== 'string' || !/^[\w-]+$/.test(item.vodId)) {
      return NextResponse.json({ error: '影片数据无效' }, { status: 400 });
    }
    if (typeof item.sourceUrl !== 'string' || !/^https?:\/\//.test(item.sourceUrl)) {
      return NextResponse.json({ error: '点播源地址无效' }, { status: 400 });
    }
  }
  // 代理模式兜底：配置未填 publicBaseUrl 时，用创建任务的请求地址推导
  // （媒体服务器按 strm 里的地址回取，需与用户访问本站的地址一致）
  const config = getStrmConfig();
  let baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
  if (!baseUrl && config.urlMode === 'proxy' && !config.publicBaseUrl) {
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    if (host) {
      const proto = req.headers.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
      baseUrl = `${proto}://${host}`;
    }
  }
  // 纠正不可用地址：浏览器经 FN Connect 中继访问时，Host 就是 *.fnos.net 域名，
  // 而该域名只有带 fnOS 登录态的浏览器能过，播放器/Emby 一律 403 → 换成局域网地址。
  const resolved = resolveStrmBaseUrl(baseUrl);
  try {
    const task = createTask({ ...body, baseUrl: resolved.baseUrl, warning: resolved.warning });
    return NextResponse.json({ task });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '创建任务失败' },
      { status: 400 }
    );
  }
}
