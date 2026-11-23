import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { findActiveJob } from '@/lib/strm/jobs';
import { refreshFolderFromSource } from '@/lib/strm/refresh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 文件夹级手动更新：用一个指定源重新抓取该文件夹对应的影片，覆盖其中的 strm。
 *
 * POST {dir, sourceUrl, sourceName?, sourceKey?}
 *   dir       相对输出目录的文件夹（如「电视剧/凡仙修仙传 (2020)」）
 *   sourceUrl 采集站接口地址（浏览器里的源列表由前端带上来，服务端不存会话）
 *
 * 检查作业运行中拒绝执行：两者都会改写同一批 strm，并发写没有意义。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { dir?: unknown; sourceUrl?: unknown; sourceName?: unknown; sourceKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
  const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
  if (!dir) return NextResponse.json({ error: '缺少 dir' }, { status: 400 });
  if (!/^https?:\/\//i.test(sourceUrl)) {
    return NextResponse.json({ error: '缺少有效的 sourceUrl' }, { status: 400 });
  }

  const active = findActiveJob();
  if (active) {
    return NextResponse.json(
      { error: '检查作业正在执行，等它结束再更新（避免同时改写同一批文件）' },
      { status: 409 }
    );
  }

  try {
    const result = await refreshFolderFromSource({
      dir,
      sourceUrl,
      sourceName: typeof body.sourceName === 'string' ? body.sourceName : undefined,
      sourceKey: typeof body.sourceKey === 'string' ? body.sourceKey : undefined,
    });
    // 业务失败也返回 200：前端要看 result.candidates（该源搜到的相近标题）来换源
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '更新失败' },
      { status: 500 }
    );
  }
}
