import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE,
  checkRateLimit,
  clearRateLimit,
  isPasswordConfigured,
  sessionCookieOptions,
  setPassword,
  signSession,
} from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * 首次启动：自行设置访问密码。
 *
 * 为什么需要这个接口：
 * fnOS 的安装向导在「升级」「用户跳过」「向导未展示」等场景下不会收集密码，
 * 旧版安装回调会退而生成一个随机密码写进 var/env，只在安装日志里露一次面，
 * 用户随即被锁在门外；而前端那时只有一句"请联系管理员配置 PASSWORD 环境变量"，
 * 对 NAS 用户是条死路。
 *
 * 现在的约定：没有密码就让用户在首次打开 Web 界面时自己设一个，
 * 落盘到数据目录（TRIM_PKGVAR/password.json），升级不丢；设过一次之后本接口永久关闭。
 */

export async function POST(req: Request) {
  // 已有密码（env 或密码文件）→ 不再接受设置，防止旁人抢先设置
  if (isPasswordConfigured()) {
    return NextResponse.json(
      { success: false, error: '已设置访问密码，如需修改请在应用中心的「设置」中操作' },
      { status: 409 }
    );
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { success: false, error: '尝试次数过多，请 10 分钟后再试' },
      { status: 429 }
    );
  }

  let password = '';
  let confirm = '';
  try {
    const body = (await req.json()) as { password?: string; confirm?: string };
    password = String(body.password ?? '');
    confirm = String(body.confirm ?? body.password ?? '');
  } catch {
    return NextResponse.json({ success: false, error: '请求格式错误' }, { status: 400 });
  }

  if (password !== confirm) {
    return NextResponse.json({ success: false, error: '两次输入的密码不一致' }, { status: 400 });
  }

  const result = setPassword(password);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }

  clearRateLimit(ip);
  // 设置完成即登录：省掉用户再输一遍
  const { token, expiresAt } = signSession();
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(req, expiresAt));
  return res;
}
