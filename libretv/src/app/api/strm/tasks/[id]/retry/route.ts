import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { retryTask } from '@/lib/strm/tasks';

export const runtime = 'nodejs';

/** POST：重试任务（仅重置未完成影片，已生成的文件会跳过？不——按覆盖逻辑刷新） */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { id } = await ctx.params;
  if (!retryTask(id)) {
    return NextResponse.json({ error: '任务不存在或正在运行' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
