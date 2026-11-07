import { NextResponse } from 'next/server';
import { isPasswordConfigured, sessionFromCookieHeader } from './auth';

/** API Route 共享守卫：未配置密码返回 503（前端据此进入「首次设置密码」），未登录返回 401 */
export function guardRequest(req: Request): NextResponse | null {
  if (!isPasswordConfigured()) {
    return NextResponse.json(
      { error: '尚未设置访问密码，请先完成首次密码设置' },
      { status: 503 }
    );
  }
  if (!sessionFromCookieHeader(req.headers.get('cookie'))) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }
  return null;
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
