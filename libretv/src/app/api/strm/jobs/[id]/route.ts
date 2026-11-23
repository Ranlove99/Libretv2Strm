import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cancelJob, getJob, jobView, pauseJob, resumeJob } from '@/lib/strm/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单个作业控制。
 * body: { action: 'pause' | 'resume' | 'cancel' }
 * - pause  暂停（已完成的结果保留，可继续）
 * - resume 继续（只跑未完成的项）
 * - cancel 取消（不会再自动续跑）
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const { id } = await ctx.params;
  if (!getJob(id)) return NextResponse.json({ error: '作业不存在' }, { status: 404 });

  let action = '';
  try {
    action = ((await req.json()) as { action?: string }).action ?? '';
  } catch {
    // 空 body 视为非法
  }

  switch (action) {
    case 'pause':
      pauseJob(id);
      break;
    case 'resume':
      resumeJob(id);
      break;
    case 'cancel':
      cancelJob(id);
      break;
    default:
      return NextResponse.json({ error: '不支持的操作' }, { status: 400 });
  }

  const job = getJob(id);
  return NextResponse.json({ ok: true, job: job ? jobView(job) : null });
}
