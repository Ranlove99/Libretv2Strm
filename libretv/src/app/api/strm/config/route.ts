import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getStrmConfig, saveStrmConfig, strmDataRoot, getDefaultOutputDir, takeStrmMigrationNotice } from '@/lib/strm/config';
import { lanBaseUrls, resolveStrmBaseUrl } from '@/lib/strm/base-url';
import fs from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';

/** GET：当前配置 + 数据目录信息 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const config = getStrmConfig();
  let outputExists = false;
  let outputWritable = false;
  try {
    fs.accessSync(config.outputDir, fs.constants.W_OK);
    outputExists = true;
    outputWritable = true;
  } catch {
    outputExists = fs.existsSync(config.outputDir);
  }
  return NextResponse.json({
    config,
    dataRoot: strmDataRoot(),
    defaultOutputDir: getDefaultOutputDir(),
    outputExists,
    outputWritable,
    // 本机局域网地址候选：strm 由媒体服务器回取，局域网地址是最可靠的默认值
    detectedBaseUrls: lanBaseUrls(),
    // 旧版本配置被自动迁移时的说明（只在首次读取返回一次）
    notice: takeStrmMigrationNotice(),
  });
}

/** POST：保存配置（部分字段即可） */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
  // 对外地址纠正：中继域名（*.fnos.net 等）只有登录态浏览器能过，
  // 写进 strm 必然播放失败，保存时直接换成局域网地址并把原因回给前端
  const resolvedPublic =
    typeof body.publicBaseUrl === 'string' ? resolveStrmBaseUrl(body.publicBaseUrl) : undefined;
  try {
    const saved = saveStrmConfig({
      outputDir: typeof body.outputDir === 'string' ? body.outputDir : undefined,
      urlMode: body.urlMode === 'direct' || body.urlMode === 'proxy' ? body.urlMode : undefined,
      publicBaseUrl: resolvedPublic ? resolvedPublic.baseUrl : undefined,
      movieTemplate: typeof body.movieTemplate === 'string' ? body.movieTemplate : undefined,
      tvTemplate: typeof body.tvTemplate === 'string' ? body.tvTemplate : undefined,
      generateNfo: typeof body.generateNfo === 'boolean' ? body.generateNfo : undefined,
      downloadPoster: typeof body.downloadPoster === 'boolean' ? body.downloadPoster : undefined,
      separateTv: typeof body.separateTv === 'boolean' ? body.separateTv : undefined,
      concurrency: typeof body.concurrency === 'number' ? body.concurrency : undefined,
      maxEpisodes: typeof body.maxEpisodes === 'number' ? body.maxEpisodes : undefined,
      verifyAfterGenerate: typeof body.verifyAfterGenerate === 'boolean' ? body.verifyAfterGenerate : undefined,
      autoCheck: typeof body.autoCheck === 'boolean' ? body.autoCheck : undefined,
      autoCheckMode: body.autoCheckMode === 'daily' || body.autoCheckMode === 'interval' ? body.autoCheckMode : undefined,
      autoCheckAt: typeof body.autoCheckAt === 'string' ? body.autoCheckAt : undefined,
      autoCheckEveryDays: typeof body.autoCheckEveryDays === 'number' ? body.autoCheckEveryDays : undefined,
      autoCheckEveryHours: typeof body.autoCheckEveryHours === 'number' ? body.autoCheckEveryHours : undefined,
      autoFix: typeof body.autoFix === 'boolean' ? body.autoFix : undefined,
    });
    // 保存后立即验证输出目录可用性，失败早报错
    try {
      fs.mkdirSync(saved.outputDir, { recursive: true });
      fs.accessSync(saved.outputDir, fs.constants.W_OK);
    } catch {
      return NextResponse.json({ error: `输出目录不可写: ${path.normalize(saved.outputDir)}` }, { status: 400 });
    }
    return NextResponse.json({ config: saved, warning: resolvedPublic?.warning });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '保存失败' },
      { status: 400 }
    );
  }
}
