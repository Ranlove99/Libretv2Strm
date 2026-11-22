import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchCatalogHome, fetchCatalogList, type CmsSource } from '@/lib/strm/cms-catalog';

export const runtime = 'nodejs';

function parseSource(raw: string | null): CmsSource | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as CmsSource;
    if (!obj || !/^https?:\/\//.test(obj.url || '')) return null;
    if (!obj.key || !obj.name) return null;
    return { key: obj.key, name: obj.name, url: obj.url.replace(/\/+$/, ''), detail: obj.detail };
  } catch {
    return null;
  }
}

/**
 * 采集站目录浏览：
 * - 无 t 参数：返回分类树 + 最新列表（?ac=videolist 根接口）
 * - 带 t 参数：返回该分类分页列表
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const sp = new URL(req.url).searchParams;
  const source = parseSource(sp.get('source'));
  if (!source) {
    return NextResponse.json({ error: '无效的点播源配置' }, { status: 400 });
  }
  const typeId = sp.get('t');
  try {
    if (!typeId) {
      const home = await fetchCatalogHome(source);
      return NextResponse.json(home);
    }
    const page = Math.max(1, Number.parseInt(sp.get('pg') || '1', 10) || 1);
    const list = await fetchCatalogList(source, typeId, page);
    return NextResponse.json(list);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '目录获取失败' },
      { status: 502 }
    );
  }
}
