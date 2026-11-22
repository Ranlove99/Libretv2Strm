import os from 'node:os';

/**
 * STRM 播放地址的「对外地址」解析。
 *
 * 关键认知：.strm 里的地址是给 **媒体服务器**（fnOS 影视 / Emby / Jellyfin / Infuse）
 * 回取拉流用的，不是给浏览器用的。所以必须选一个「媒体服务器能直连」的地址：
 *   - 媒体服务器与 LibreTV 同机 / 同局域网 → http://<NAS-IP>:8099
 *   - 跨网播放 → 端口映射 / DDNS / 反向代理得到的公网地址
 *
 * fnOS 的 FN Connect 中继域名（*.fnos.net / *.5ddd.com）只有携带 fnOS 登录态的
 * 浏览器请求才能通过；未登录请求会被中继网关直接挡在边缘，返回
 * 403「FN Connect 暂无权限访问该服务」的 HTML 页（不是本站响应）。
 * 播放器、Emby、以及生成后的自动验证都拿不到 fnOS 登录态，因此中继域名
 * 写进 strm 必然不可播 —— 这里统一纠正为局域网地址。
 */

/** fnOS 中继（FN Connect）域名后缀 */
const RELAY_DOMAINS = ['fnos.net', '5ddd.com', 'fnos.com'];

/** 是否为 fnOS 中继域名（中继只能浏览器登录后访问，媒体服务器不可用） */
export function isRelayHost(host: string): boolean {
  const h = (host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!h) return false;
  return RELAY_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

/** 本机监听端口：fnOS 包由 cmd/main 注入 PORT=8099；dev/start 由脚本指定 */
export function listenPort(): number {
  const fromEnv = Number.parseInt(process.env.PORT || process.env.STRM_LOCAL_PORT || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  return 8099;
}

/** 网卡名过滤：虚拟网桥 / 容器 / 隧道网卡不参与对外地址推荐 */
const VIRTUAL_IFACE = /^(lo|docker|br-|veth|virbr|cni|flannel|vnet|tun|tap|utun|zt|wg)/i;

/** 局域网地址优先级：私网段 > CGNAT(Tailscale 等) > 其他 */
function ipScore(ip: string): number {
  if (/^192\.168\./.test(ip)) return 40;
  if (/^10\./.test(ip)) return 40;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 30;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 20;
  return 0;
}

/** 本机局域网 IPv4 列表（按可用性排序，已剔除回环/虚拟网卡） */
export function lanIpv4(): string[] {
  const found: { ip: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const score = ipScore(addr.address);
      if (score > 0) found.push({ ip: addr.address, score });
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.ip);
}

/** 推荐的对外地址候选（供设置页一键填入） */
export function lanBaseUrls(): string[] {
  const port = listenPort();
  return lanIpv4().map((ip) => `http://${ip}:${port}`);
}

export interface BaseUrlResolution {
  /** 最终写入 strm 的地址（已去尾部斜杠）；空串表示未配置 */
  baseUrl: string;
  /** 非致命提示：地址被自动纠正的原因，供任务明细 / 界面展示 */
  warning?: string;
}

/** 校验并纠正用于写 strm 的对外地址 */
export function resolveStrmBaseUrl(raw: string): BaseUrlResolution {
  const value = (raw || '').trim().replace(/\/+$/, '');
  if (!value) return { baseUrl: '' };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { baseUrl: value, warning: `对外访问地址不是合法 URL：${value}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { baseUrl: value, warning: `对外访问地址协议不支持：${url.protocol}` };
  }
  if (!isRelayHost(url.hostname)) return { baseUrl: value };

  const fallback = lanBaseUrls()[0];
  if (fallback) {
    return {
      baseUrl: fallback,
      warning:
        `中继域名 ${url.hostname} 只有已登录的浏览器能访问，媒体服务器/播放器会被 FN Connect ` +
        `网关拒绝（403），已自动改用局域网地址 ${fallback}。` +
        `如需跨网播放，请改用端口映射或反向代理得到的公网地址。`,
    };
  }
  return {
    baseUrl: value,
    warning:
      `中继域名 ${url.hostname} 无法被媒体服务器访问，且未探测到本机局域网 IPv4 地址，` +
      `请在设置里手动填写「对外访问地址」（如 http://<NAS-IP>:${listenPort()}）。`,
  };
}

/** 本机回环基址：验证时避开防火墙 / 回环 DNS / 中继网关 */
export function loopbackBaseUrl(port?: string): string {
  return `http://127.0.0.1:${port || listenPort()}`;
}
