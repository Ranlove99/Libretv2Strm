import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cancelTask } from '@/lib/strm/tasks';

export const runtime = 'nodejs';

/** POST：取消任务（中断在途请求，未完成影片保持 pending 态供重试） */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { id } = await ctx.params;
  if (!cancelTask(id)) {
    return NextResponse.json({ error: '任务不存在或已结束' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
