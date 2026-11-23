import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { autoSummary, runAutoCheck } from '@/lib/strm/auto';
import { ensureStrmScheduler } from '@/lib/strm/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * STRM 自动检查 / 自动修复。
 *
 * GET               读取开关、下次执行时间、上次执行结果（打开面板即唤醒调度器）
 * POST {action:run} 立即按自动任务的方式执行一次（后台跑，结果靠 GET 轮询）
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  // 打开设置页即唤醒调度器，避免应用长时间空闲后首次 tick 要等到下一分钟
  ensureStrmScheduler();
  return NextResponse.json(autoSummary(), { headers: NO_STORE });
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { action?: string } = {};
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    // 空 body 视为 run
  }
  if (body.action && body.action !== 'run') {
    return NextResponse.json({ error: '不支持的操作' }, { status: 400 });
  }

  try {
    ensureStrmScheduler();
    const r = await runAutoCheck({ manual: true });
    return NextResponse.json({ ...r, summary: autoSummary() }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '执行失败' },
      { status: 400 }
    );
  }
}
