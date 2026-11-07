import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 会话鉴权：httpOnly cookie + HMAC 签名。
 *
 * 相比旧版的改进：
 * - 页面源码不再下发 sha256(password)，前端拿不到任何可重放的凭证；
 * - 兼容模式「哈希即凭证」被彻底移除；
 * - 登录接口只接受 POST body，不再把明文密码放 query。
 *
 * 密码来源（优先级从高到低）：
 * 1. `PASSWORD` 环境变量（fnOS 安装向导 / 应用中心「设置」写入 var/env，cmd/main 启动时注入）；
 * 2. 数据目录下的 password.json（用户在 Web 界面首次启动时自行设置）。
 * 两者都没有时 isPasswordConfigured() 为 false，前端进入「首次设置密码」流程，
 * 不再出现旧版"请联系管理员配置 PASSWORD 环境变量"的死路。
 */

/** 密码长度规则，与 fnOS 安装向导 wizard/install 的 rules 保持一致 */
export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 64;

export const SESSION_COOKIE = 'ltv_session';
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 天

/**
 * 应用数据根目录。
 * fnOS 安装时 cmd/main 与安装回调都把数据放在 TRIM_PKGVAR（/var/apps/libretv/var），
 * 该目录在升级与重装时由系统保留，故自设密码放这里能在升级后继续生效。
 */
export function appDataRoot(): string {
  return (
    process.env.TRIM_PKGVAR ||
    process.env.LIBRETV_DATA_DIR ||
    path.join(process.cwd(), '.data')
  );
}

function passwordFilePath(): string {
  return path.join(appDataRoot(), 'password.json');
}

/** undefined=未读过，空串=读过但没设；缓存避免每次 getPassword() 都读盘 */
let cachedFilePassword: string | undefined;

/** 读取用户在 Web 界面自设的密码（env 未提供时的兜底） */
function readPasswordFile(): string {
  if (cachedFilePassword !== undefined) return cachedFilePassword;
  cachedFilePassword = '';
  try {
    const raw = fs.readFileSync(passwordFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { password?: unknown };
    if (typeof parsed.password === 'string') cachedFilePassword = parsed.password;
  } catch {
    // 文件不存在 / 不可读 / 格式异常：一律视为未设置，由首次设置流程接管
  }
  return cachedFilePassword;
}

export function getPassword(): string {
  return process.env.PASSWORD || readPasswordFile();
}

export function isPasswordConfigured(): boolean {
  return getPassword().length > 0;
}

/** 设置访问密码：原子写入数据目录，并在当前进程立即生效（无需重启） */
export function setPassword(password: string): { ok: true } | { ok: false; error: string } {
  // 显式拒绝非字符串：否则 12345 这类数字会被 String() 强转成合法密码，语义含糊
  if (typeof password !== 'string') {
    return { ok: false, error: '密码格式不正确' };
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `密码长度需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 个字符` };
  }
  const file = passwordFilePath();
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, password, updatedAt: Date.now() }, null, 2));
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件清理失败不影响主流程
    }
    return { ok: false, error: err instanceof Error ? err.message : '保存密码失败' };
  }
  cachedFilePassword = password;
  process.env.PASSWORD = password;
  return { ok: true };
}

function getSecret(): string {
  if (process.env.PROXY_SECRET) return process.env.PROXY_SECRET;
  return crypto.createHash('sha256').update(getPassword() + ':libretv::session-salt').digest('hex');
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
}

/** 生成签名会话 token：`<expiresAtMs>.<hmac>` */
export function signSession(): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  return { token: `${payload}.${hmac(payload)}`, expiresAt };
}

/** 校验会话 token 的签名与有效期 */
export function verifySession(token: string | undefined | null): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expiresAt = parseInt(payload, 10);
  if (!Number.isFinite(expiresAt)) return false;
  return Date.now() < expiresAt;
}

/**
 * 会话 Cookie 选项。
 * Secure 策略：COOKIE_SECURE 环境变量显式覆盖；否则按 x-forwarded-proto 推导。
 * 不能依赖 req.url——Next.js Route Handler 中它是内部转发地址，并非用户侧的原始协议。
 */
export function sessionCookieOptions(
  req: { headers: Headers },
  expiresAt: number
): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  maxAge: number;
  path: string;
} {
  const forwarded = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'http';
  const secure =
    process.env.COOKIE_SECURE === 'true'
      ? true
      : process.env.COOKIE_SECURE === 'false'
        ? false
        : forwarded === 'https';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: Math.floor((expiresAt - Date.now()) / 1000),
    path: '/',
  };
}

/** 恒定时间比较密码（比较 sha256 摘要避免长度泄漏） */
export function checkPassword(input: string): boolean {
  const password = getPassword();
  if (!password) return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

/** 从请求 Cookie 中解析会话 */
export function sessionFromCookieHeader(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  const cookies = cookieHeader.split(';');
  for (const c of cookies) {
    const eq = c.indexOf('=');
    if (eq === -1) continue;
    const name = c.slice(0, eq).trim();
    if (name === SESSION_COOKIE) {
      return verifySession(decodeURIComponent(c.slice(eq + 1).trim()));
    }
  }
  return false;
}

// —— 登录速率限制（内存实现，单实例部署足够；多实例可换 Redis） ——

const attemptMap = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attemptMap.get(ip);
  if (!entry || now > entry.resetAt) {
    attemptMap.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

export function clearRateLimit(ip: string): void {
  attemptMap.delete(ip);
}

// 定期清理过期限流记录，避免长期运行下 Map 膨胀
if (typeof setInterval === 'function') {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of attemptMap) {
      if (now > entry.resetAt) attemptMap.delete(ip);
    }
  }, 60 * 1000);
  // 不阻止 Node 进程退出
  if (typeof timer.unref === 'function') timer.unref();
}
