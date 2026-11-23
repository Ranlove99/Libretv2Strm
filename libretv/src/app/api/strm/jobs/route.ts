import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getStrmConfig } from '@/lib/strm/config';
import { collectStrmFiles } from '@/lib/strm/repair';
import { createJob, getJob, healStaleJobs, jobView, listJobs, startJob } from '@/lib/strm/jobs';
import { ensureStrmScheduler } from '@/lib/strm/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * STRM 检查 / 修复作业。
 *
 * GET  ?id=     读取单个作业（含进度与问题明细）
 * GET           最近作业列表 + 当前正在执行的作业
 * POST {repair?, deep?, verify?}
 *               扫描输出目录并创建作业，立即返回；执行在服务端继续，关页面不影响
 *
 * 作业落盘在 jobs.json，进程重启后由调度器自动接手未完成的部分。
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  // 读取前先修正「进程已死但状态还是 running」的记录，避免页面一直转圈
  healStaleJobs();
  ensureStrmScheduler();

  const id = new URL(req.url).searchParams.get('id');
  if (id) {
    const job = getJob(id);
    if (!job) return NextResponse.json({ error: '作业不存在' }, { status: 404 });
    return NextResponse.json({ job: jobView(job), now: Date.now() }, { headers: NO_STORE });
  }

  const jobs = listJobs(8);
  const active = jobs.find((j) => j.status === 'running');
  return NextResponse.json({ jobs, active: active ?? null, now: Date.now() }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: { repair?: boolean; deep?: boolean; verify?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // 空 body 按默认参数处理
  }

  const cfg = getStrmConfig();
  let files: string[] = [];
  try {
    files = (await collectStrmFiles(cfg.outputDir)).files;
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

  // 已有作业在跑时复用，不重复创建；否则启动并立刻返回，进度靠 GET 轮询
  if (!reused) void startJob(job);

  return NextResponse.json({ job: jobView(job), reused }, { headers: NO_STORE });
}
