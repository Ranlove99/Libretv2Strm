import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { flushSources, registerSources, sourceViews } from '@/lib/strm/source-stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 数据源注册表与评分。
 *
 * GET  全部源的评分视图（按分数降序）：设置页展示。
 * POST 上报当前源列表（浏览器 IndexedDB 里的订阅 / 自定义 / 环境源）。
 *      服务端持久化到 sources.json，检查 / 修复作业据此做跨源替代。
 *      重复上报是幂等的：已登记的源只补名称，评分统计不动。
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  return NextResponse.json(
    { sources: sourceViews(), now: Date.now() },
    { headers: NO_STORE }
  );
}

interface SourceReportBody {
  sources?: Array<{ key?: unknown; name?: unknown; url?: unknown }>;
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: SourceReportBody;
  try {
    body = (await req.json()) as SourceReportBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  if (!Array.isArray(body.sources)) {
    return NextResponse.json({ error: '缺少 sources 数组' }, { status: 400 });
  }

  const list = body.sources
    .filter((s): s is { key?: string; name?: string; url: string } =>
      typeof s?.url === 'string' && /^https?:\/\//i.test(s.url)
    )
    .map((s) => ({
      key: typeof s.key === 'string' ? s.key : undefined,
      name: typeof s.name === 'string' ? s.name : undefined,
      url: s.url,
    }));

  const added = registerSources(list);
  flushSources();
  return NextResponse.json(
    { ok: true, registered: list.length, added, sources: sourceViews() },
    { headers: NO_STORE }
  );
}
