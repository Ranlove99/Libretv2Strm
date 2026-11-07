import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 访问密码持久化单测（首次启动自设密码）。
 *
 * 覆盖三类来源与它们的优先级、长度校验、以及「重启后仍然记得」——
 * 后者直接对应 fnOS 升级不丢数据目录（TRIM_PKGVAR 由系统保留）这一约束。
 */

type AuthModule = typeof import('./auth');

let dataDir: string;
let previousPassword: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libretv-pw-'));
  previousPassword = process.env.PASSWORD;
  delete process.env.PASSWORD;
  process.env.TRIM_PKGVAR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (previousPassword === undefined) delete process.env.PASSWORD;
  else process.env.PASSWORD = previousPassword;
  delete process.env.TRIM_PKGVAR;
  delete process.env.COOKIE_SECURE;
  vi.resetModules();
});

/** 每次重新 import：auth.ts 内部有文件读取缓存，resetModules 才能模拟「进程重启」 */
async function loadAuth(): Promise<AuthModule> {
  return import('./auth');
}

function passwordFile(): string {
  return path.join(dataDir, 'password.json');
}

describe('密码来源与优先级', () => {
  it('env 与密码文件都没有时：未配置', async () => {
    const auth = await loadAuth();
    expect(auth.isPasswordConfigured()).toBe(false);
    expect(auth.getPassword()).toBe('');
  });

  it('setPassword 写入数据目录，getPassword / checkPassword 立即可用', async () => {
    const auth = await loadAuth();
    expect(auth.setPassword('my-pass-123')).toEqual({ ok: true });
    expect(fs.existsSync(passwordFile())).toBe(true);
    expect(auth.getPassword()).toBe('my-pass-123');
    expect(auth.checkPassword('my-pass-123')).toBe(true);
    expect(auth.checkPassword('wrong')).toBe(false);
    expect(auth.isPasswordConfigured()).toBe(true);
  });

  it('密码文件权限为 600（避免同机其他用户读到明文）', async () => {
    const auth = await loadAuth();
    auth.setPassword('my-pass-123');
    expect(fs.statSync(passwordFile()).mode & 0o777).toBe(0o600);
  });

  it('重启（重新加载模块）后仍记得自设密码', async () => {
    (await loadAuth()).setPassword('my-pass-123');
    // 模拟进程重启：env 已清空、模块缓存已清空，只留磁盘上的密码文件
    const auth = await loadAuth();
    expect(auth.getPassword()).toBe('my-pass-123');
    expect(auth.isPasswordConfigured()).toBe(true);
  });

  it('env PASSWORD 优先于密码文件（安装向导写入的 env 说了算）', async () => {
    process.env.PASSWORD = 'from-env';
    const auth = await loadAuth();
    expect(auth.getPassword()).toBe('from-env');
  });

  it('env 为空串时回落到密码文件', async () => {
    (await loadAuth()).setPassword('from-file');
    process.env.PASSWORD = '';
    const auth = await loadAuth();
    expect(auth.getPassword()).toBe('from-file');
  });

  it('密码文件损坏（非法 JSON / 无 password 字段）按未设置处理', async () => {
    fs.writeFileSync(passwordFile(), '{not json');
    expect((await loadAuth()).isPasswordConfigured()).toBe(false);

    fs.writeFileSync(passwordFile(), JSON.stringify({ version: 1 }));
    expect((await loadAuth()).isPasswordConfigured()).toBe(false);
  });
});

describe('setPassword 长度校验', () => {
  it('与 fnOS 安装向导规则一致：4-64', async () => {
    const auth = await loadAuth();
    expect(auth.setPassword('abc')).toEqual({ ok: false, error: '密码长度需为 4-64 个字符' });
    expect(auth.setPassword('')).toEqual({ ok: false, error: '密码长度需为 4-64 个字符' });
    expect(auth.setPassword('a'.repeat(65))).toEqual({ ok: false, error: '密码长度需为 4-64 个字符' });

    expect(auth.setPassword('abcd')).toEqual({ ok: true });
    expect(auth.setPassword('a'.repeat(64))).toEqual({ ok: true });
  });

  it('非字符串入参被拒绝而不是抛错', async () => {
    const auth = await loadAuth();
    // @ts-expect-error 故意传入错误类型，验证运行时不炸
    expect(auth.setPassword(undefined).ok).toBe(false);
    // @ts-expect-error 故意传入错误类型，验证运行时不炸
    expect(auth.setPassword(12345).ok).toBe(false);
  });
});

describe('sessionCookieOptions', () => {
  const req = (proto: string | null) => ({
    headers: new Headers(proto ? { 'x-forwarded-proto': proto } : {}),
  });

  it('默认按 x-forwarded-proto 推导 Secure', async () => {
    const auth = await loadAuth();
    const expiresAt = Date.now() + 1000;
    expect(auth.sessionCookieOptions(req('https'), expiresAt).secure).toBe(true);
    expect(auth.sessionCookieOptions(req('http'), expiresAt).secure).toBe(false);
    expect(auth.sessionCookieOptions(req(null), expiresAt).secure).toBe(false);
  });

  it('COOKIE_SECURE 可显式覆盖推导结果', async () => {
    const auth = await loadAuth();
    process.env.COOKIE_SECURE = 'true';
    expect(auth.sessionCookieOptions(req('http'), Date.now() + 1000).secure).toBe(true);
    process.env.COOKIE_SECURE = 'false';
    expect(auth.sessionCookieOptions(req('https'), Date.now() + 1000).secure).toBe(false);
  });

  it('httpOnly / sameSite / path 固定，maxAge 由过期时间换算', async () => {
    const auth = await loadAuth();
    const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
    const opts = auth.sessionCookieOptions(req('http'), expiresAt);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBeGreaterThan(89 * 24 * 60 * 60);
  });
});
