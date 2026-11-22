import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getStrmConfig } from '@/lib/strm/config';
import { checkAndRepairStrm } from '@/lib/strm/repair';
import { listTasks } from '@/lib/strm/tasks';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface RepairBody {
  repair?: boolean;
  deep?: boolean;
  verify?: boolean;
  maxFiles?: number;
}

/**
 * 检查（并可选修复）输出目录里的 .strm 文件。
 * body: { repair?: boolean; deep?: boolean; verify?: boolean; maxFiles?: number }
 * - repair 默认 true（结构修复）；
 * - deep / verify 默认 false（都会联网，较慢，由用户显式开启）。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: RepairBody = {};
  try {
    body = (await req.json()) as RepairBody;
  } catch {
    // 空 body 按默认参数处理
  }

  const maxFiles = Number.parseInt(String(body.maxFiles ?? ''), 10);
  const result = await checkAndRepairStrm(getStrmConfig(), listTasks(), {
    repair: body.repair !== false,
    deep: body.deep === true,
    verify: body.verify === true,
    maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? Math.min(maxFiles, 20000) : undefined,
  });
  return NextResponse.json(result);
}
