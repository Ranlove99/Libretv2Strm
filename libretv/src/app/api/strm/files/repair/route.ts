import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getStrmConfig } from '@/lib/strm/config';
import { collectStrmFiles } from '@/lib/strm/repair';
import { createJob, jobView, startJob } from '@/lib/strm/jobs';

export const runtime = 'nodejs';

/**
 * 兼容入口：等价于 POST /api/strm/jobs。
 *
 * 1.3.0 起检查改由后台作业执行（关页面也继续、可续跑、有进度），
 * 这里保留旧路径避免缓存页面报 404，返回结构改为 { job, reused }。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { repair?: boolean; deep?: boolean; verify?: boolean; maxFiles?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // 空 body 按默认参数处理
  }

  const cfg = getStrmConfig();
  let files: string[] = [];
  try {
    files = (await collectStrmFiles(cfg.outputDir)).files;
    const maxFiles = Number.parseInt(String(body.maxFiles ?? ''), 10);
    if (Number.isFinite(maxFiles) && maxFiles > 0) files = files.slice(0, Math.min(maxFiles, 20000));
  } catch (err) {
    return NextResponse.json(
      { error: `读取输出目录失败：${err instanceof Error ? err.message : '未知错误'}` },
      { status: 400 }
    );
  }

  const { job, reused } = createJob(files, {
    trigger: 'manual',
    repair: body.repair !== false,
    deep: body.deep === true,
    verify: body.verify === true,
  });
  if (!reused) void startJob(job);

  return NextResponse.json({ job: jobView(job), reused });
}
