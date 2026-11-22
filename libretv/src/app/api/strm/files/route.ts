import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getStrmConfig } from '@/lib/strm/config';
import fs from 'node:fs';
import path from 'node:path';
import type { StrmFileEntry } from '@/lib/strm/types';

export const runtime = 'nodejs';

const MAX_ENTRIES = 2000;

/**
 * 输出目录浏览：?dir=相对路径（默认根目录）
 * 返回直接子条目（目录/文件）+ 递归统计（strm 数量、总大小）。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const config = getStrmConfig();
  const root = path.resolve(config.outputDir);
  const rel = (new URL(req.url).searchParams.get('dir') || '').replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return NextResponse.json({ error: '非法的目录路径' }, { status: 400 });
  }

  let entries: StrmFileEntry[] = [];
  try {
    const dirents = await fs.promises.readdir(abs, { withFileTypes: true });
    const stats = await Promise.all(
      dirents.slice(0, MAX_ENTRIES).map(async (d): Promise<StrmFileEntry> => {
        const entryAbs = path.join(abs, d.name);
        try {
          const st = await fs.promises.stat(entryAbs);
          return {
            name: d.name,
            path: path.relative(root, entryAbs).split(path.sep).join('/'),
            isDir: d.isDirectory(),
            size: d.isDirectory() ? 0 : st.size,
            mtime: st.mtimeMs,
          };
        } catch {
          return { name: d.name, path: d.name, isDir: d.isDirectory(), size: 0, mtime: 0 };
        }
      })
    );
    entries = stats.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  } catch {
    // 目录不存在时返回空列表（首次使用的正常状态）
  }

  // 递归统计（限深度 6，防超大目录卡死）
  let strmCount = 0;
  let totalSize = 0;
  try {
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6) return;
      const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const d of dirents) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) {
          await walk(p, depth + 1);
        } else {
          const st = await fs.promises.stat(p);
          totalSize += st.size;
          if (d.name.endsWith('.strm')) strmCount += 1;
        }
      }
    };
    await walk(root, 0);
  } catch {
    // 统计失败不影响列表返回
  }

  return NextResponse.json({
    root,
    dir: rel,
    exists: fs.existsSync(root),
    entries,
    stats: { strmCount, totalSize },
  });
}
