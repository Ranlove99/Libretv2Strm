import { describe, expect, it } from 'vitest';
import { isRelayHost, lanIpv4, listenPort, resolveStrmBaseUrl } from './base-url';
import { normalizeVerifyUrl } from './verify';

/**
 * 中继域名（FN Connect）不可用于 strm 的回归测试。
 *
 * 背景：strm 里的地址由媒体服务器（fnOS 影视 / Emby / Jellyfin）回取拉流，
 * 而 *.fnos.net 中继域名只放行带 fnOS 登录态的浏览器请求，其余请求被中继
 * 网关直接 403（「FN Connect 暂无权限访问该服务」）。因此：
 *   1) 生成阶段必须把中继域名纠正为局域网地址；
 *   2) 验证阶段回环改写必须保留端口（原来丢端口 → 落到 80 → 必然失败）。
 */

describe('isRelayHost', () => {
  it('识别 fnOS 中继域名', () => {
    expect(isRelayHost('libretv-main.xiximeimei.fnos.net')).toBe(true);
    expect(isRelayHost('abc.5ddd.com')).toBe(true);
    expect(isRelayHost('fnos.net')).toBe(true);
  });

  it('普通局域网/公网域名不误判', () => {
    expect(isRelayHost('192.168.1.118')).toBe(false);
    expect(isRelayHost('192.168.1.118:8099')).toBe(false);
    expect(isRelayHost('tv.example.com')).toBe(false);
    expect(isRelayHost('notfnos.net.evil.com')).toBe(false);
    expect(isRelayHost('')).toBe(false);
  });
});

describe('resolveStrmBaseUrl', () => {
  it('中继域名纠正为局域网地址并给出提示', () => {
    const r = resolveStrmBaseUrl('https://libretv-main.xiximeimei.fnos.net');
    if (lanIpv4().length > 0) {
      expect(r.baseUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
      expect(r.baseUrl).not.toContain('fnos.net');
    }
    expect(r.warning).toBeTruthy();
    expect(r.warning).toContain('fnos.net');
  });

  it('局域网地址原样保留（去掉尾部斜杠）', () => {
    expect(resolveStrmBaseUrl('http://192.168.1.118:8099/')).toEqual({
      baseUrl: 'http://192.168.1.118:8099',
    });
  });

  it('公网反代地址原样保留', () => {
    expect(resolveStrmBaseUrl('https://tv.example.com/libretv')).toEqual({
      baseUrl: 'https://tv.example.com/libretv',
    });
  });

  it('空值与非法值', () => {
    expect(resolveStrmBaseUrl('')).toEqual({ baseUrl: '' });
    expect(resolveStrmBaseUrl('   ')).toEqual({ baseUrl: '' });
    expect(resolveStrmBaseUrl('not a url').warning).toBeTruthy();
  });
});

describe('normalizeVerifyUrl', () => {
  it('局域网地址保留端口并改走回环', () => {
    expect(normalizeVerifyUrl('http://192.168.1.118:8099/api/strm/play?u=x&sig=y')).toBe(
      'http://127.0.0.1:8099/api/strm/play?u=x&sig=y'
    );
  });

  it('中继地址（无端口）回落到本机监听端口，不能落到 80', () => {
    const out = normalizeVerifyUrl('https://libretv-main.xiximeimei.fnos.net/api/strm/play?u=x&sig=y');
    expect(out).toBe(`http://127.0.0.1:${listenPort()}/api/strm/play?u=x&sig=y`);
    expect(out).not.toMatch(/127\.0\.0\.1\/api/);
  });

  it('公网自定义域名保持原样（避免把可用地址改坏）', () => {
    const url = 'https://tv.example.com/api/strm/play?u=x&sig=y';
    expect(normalizeVerifyUrl(url)).toBe(url);
  });

  it('非代理路径不受影响', () => {
    expect(normalizeVerifyUrl('http://192.168.1.118:8099/api/status')).toBe(
      'http://192.168.1.118:8099/api/status'
    );
  });
});
