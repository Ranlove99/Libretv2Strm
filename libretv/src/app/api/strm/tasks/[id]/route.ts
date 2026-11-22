import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { deleteTask, getTask } from '@/lib/strm/tasks';

export const runtime = 'nodejs';

/** GET：任务详情 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  return NextResponse.json({ task });
}

/** DELETE：删除任务记录（运行中不可删） */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const { id } = await ctx.params;
  if (!deleteTask(id)) {
    return NextResponse.json({ error: '任务不存在或正在运行' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
