import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOriginIndex, checkAndRepairStrm, collectStrmFiles, diagnoseStrmContent } from './repair';
import { lanIpv4 } from './base-url';
import { buildProxyPlayUrl, verifyStrmUrl } from './sign';
import type { StrmConfig, StrmTask } from './types';

/** STRM 检查 / 修复：结构修复是纯函数，深度修复靠 fetch，这里只覆盖不联网的部分 */

beforeAll(() => {
  process.env.PROXY_SECRET = 'repair-test-secret';
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'strm-repair-'));
}

function cfg(outputDir: string, publicBaseUrl = 'http://192.168.1.10:8099'): StrmConfig {
  return {
    outputDir,
    urlMode: 'proxy',
    publicBaseUrl,
    movieTemplate: '{title} ({year})/{title} ({year})',
    tvTemplate: '{title} ({year})/Season {season}/{title} - S{season:02d}E{episode:02d}',
    generateNfo: true,
    downloadPoster: true,
    separateTv: true,
    concurrency: 2,
    maxEpisodes: 0,
    verifyAfterGenerate: true,
    autoCheck: false,
    autoCheckMode: 'daily',
    autoCheckAt: '03:00',
    autoCheckEveryDays: 1,
    autoCheckEveryHours: 6,
    autoFix: true,
  };
}

const CTX = { config: cfg('/tmp/x'), baseUrl: 'http://192.168.1.10:8099', explicitBase: true };
const UPSTREAM = 'https://up.example/v/index.m3u8';

describe('diagnoseStrmContent', () => {
  it('直链：去掉首尾空白与 BOM', () => {
    const r = diagnoseStrmContent(`\uFEFF${UPSTREAM}\n`, CTX);
    expect(r.kind).toBe('direct');
    expect(r.issues).toContain('whitespace');
    expect(r.changed).toBe(true);
    expect(r.content).toBe(UPSTREAM);
  });

  it('直链：内容正常时原样返回', () => {
    const r = diagnoseStrmContent(UPSTREAM, CTX);
    expect(r.changed).toBe(false);
    expect(r.unfixable).toBeUndefined();
  });

  it('代理：中继域名改写为当前对外地址并重算签名', () => {
    const relay = buildProxyPlayUrl('https://abc.fnos.net', UPSTREAM);
    const r = diagnoseStrmContent(relay, CTX);
    expect(r.issues).toContain('proxy-relay-base');
    expect(r.changed).toBe(true);
    expect(r.content.startsWith('http://192.168.1.10:8099/api/strm/play?u=')).toBe(true);
    const u = new URL(r.content).searchParams;
    expect(verifyStrmUrl(u.get('u')!, u.get('sig'))).toBe(true);
  });

  it('代理：签名失效时按当前密钥重算', () => {
    const broken = `http://192.168.1.10:8099/api/strm/play?u=${encodeURIComponent(UPSTREAM)}&sig=deadbeef`;
    const r = diagnoseStrmContent(broken, CTX);
    expect(r.issues).toContain('proxy-bad-sig');
    const u = new URL(r.content).searchParams;
    expect(verifyStrmUrl(u.get('u')!, u.get('sig'))).toBe(true);
  });

  it('代理：缺签名时补上', () => {
    const noSig = `http://192.168.1.10:8099/api/strm/play?u=${encodeURIComponent(UPSTREAM)}`;
    const r = diagnoseStrmContent(noSig, CTX);
    expect(r.issues).toContain('proxy-missing-sig');
    const u = new URL(r.content).searchParams;
    expect(verifyStrmUrl(u.get('u')!, u.get('sig'))).toBe(true);
  });

  it('代理：旧局域网 IP 改写为当前地址', () => {
    const old = buildProxyPlayUrl('http://192.168.1.99:8099', UPSTREAM);
    const r = diagnoseStrmContent(old, CTX);
    expect(r.issues).toContain('proxy-stale-lan-base');
    expect(r.content.startsWith('http://192.168.1.10:8099/api/strm/play')).toBe(true);
  });

  it('自动探测地址：旧 IP 仍属于本机时即使端口不同也不改写', () => {
    const ip = lanIpv4()[0];
    if (!ip) return; // 无局域网网卡时跳过
    const old = buildProxyPlayUrl(`http://${ip}:9999`, UPSTREAM);
    const r = diagnoseStrmContent(old, { ...CTX, baseUrl: `http://${ip}:8099`, explicitBase: false });
    expect(r.issues).not.toContain('proxy-stale-lan-base');
    expect(r.changed).toBe(false);
  });

  it('代理：地址与签名都正确时原样返回', () => {
    const good = buildProxyPlayUrl('http://192.168.1.10:8099', UPSTREAM);
    const r = diagnoseStrmContent(good, CTX);
    expect(r.changed).toBe(false);
    expect(r.issues).toHaveLength(0);
  });

  it('空文件不可修', () => {
    const r = diagnoseStrmContent('   \n', CTX);
    expect(r.kind).toBe('invalid');
    expect(r.unfixable).toBeTruthy();
  });

  it('非 URL 不可修', () => {
    const r = diagnoseStrmContent('hello world', CTX);
    expect(r.issues).toContain('not-url');
    expect(r.unfixable).toBeTruthy();
  });

  it('直链指向中继域名不可修', () => {
    const r = diagnoseStrmContent('https://abc.fnos.net/v/index.m3u8', CTX);
    expect(r.kind).toBe('direct');
    expect(r.issues).toContain('direct-relay-host');
    expect(r.unfixable).toBeTruthy();
  });

  it('代理缺上游目标不可修', () => {
    const r = diagnoseStrmContent('http://192.168.1.10:8099/api/strm/play?sig=abc', CTX);
    expect(r.issues).toContain('proxy-bad-target');
    expect(r.unfixable).toBeTruthy();
  });

  it('中继域名且当前无对外地址时不可修', () => {
    const relay = buildProxyPlayUrl('https://abc.fnos.net', UPSTREAM);
    const r = diagnoseStrmContent(relay, { ...CTX, baseUrl: '' });
    expect(r.unfixable).toBeTruthy();
  });
});

describe('collectStrmFiles', () => {
  it('递归收集 .strm 并跳过隐藏目录', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '电影/A'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(dir, '电影/A/x.strm'), 'http://a');
    fs.writeFileSync(path.join(dir, '电影/A/x.nfo'), '<movie/>');
    fs.writeFileSync(path.join(dir, '.hidden/y.strm'), 'http://b');

    const { files, truncated } = await collectStrmFiles(dir);
    expect(truncated).toBe(false);
    expect(files).toEqual(['电影/A/x.strm']);
  });

  it('超过上限时标记截断', async () => {
    const dir = tmpDir();
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.strm`), 'http://a');
    const { files, truncated } = await collectStrmFiles(dir, 3);
    expect(files).toHaveLength(3);
    expect(truncated).toBe(true);
  });
});

describe('buildOriginIndex', () => {
  it('按新到旧保留最新一条，并记录集序号', () => {
    const task = (id: string, file: string): StrmTask => ({
      id,
      title: id,
      status: 'done',
      total: 1,
      done: 1,
      failed: 0,
      createdAt: 0,
      items: [
        {
          sourceKey: 'k',
          sourceName: '源',
          sourceUrl: 'http://api.example/vod',
          vodId: '42',
          title: '片',
          status: 'done',
          episodes: [{ name: '第1集', file }],
        },
      ],
    });
    const index = buildOriginIndex([task('new', 'a/x.strm'), task('old', 'a/x.strm')]);
    const origin = index.get('a/x.strm');
    expect(origin?.taskId).toBe('new');
    expect(origin?.vodId).toBe('42');
    expect(origin?.episodeIndex).toBe(0);
  });
});

describe('checkAndRepairStrm', () => {
  it('结构修复：能修的改好，修不了的计数', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'A'), { recursive: true });

    // 1) 中继域名 + 错签名 → 应被修复
    const relay = buildProxyPlayUrl('https://abc.fnos.net', UPSTREAM);
    fs.writeFileSync(path.join(dir, 'A/relay.strm'), relay);
    // 2) 直链带换行 → 应被修复
    fs.writeFileSync(path.join(dir, 'A/direct.strm'), `${UPSTREAM}\n`);
    // 3) 空文件 → 不可修
    fs.writeFileSync(path.join(dir, 'A/empty.strm'), '');

    const result = await checkAndRepairStrm(cfg(dir), [], { repair: true });

    expect(result.scanned).toBe(3);
    expect(result.fixed).toBe(2);
    expect(result.unfixable).toBe(1);

    const fixedRelay = fs.readFileSync(path.join(dir, 'A/relay.strm'), 'utf8');
    expect(fixedRelay.startsWith('http://192.168.1.10:8099/api/strm/play?u=')).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'A/direct.strm'), 'utf8')).toBe(UPSTREAM);
  });

  it('只读检查不写盘，计入 pendingRepair', async () => {
    const dir = tmpDir();
    const relay = buildProxyPlayUrl('https://abc.fnos.net', UPSTREAM);
    fs.writeFileSync(path.join(dir, 'relay.strm'), relay);

    const result = await checkAndRepairStrm(cfg(dir), [], { repair: false });
    expect(result.fixed).toBe(0);
    expect(result.pendingRepair).toBe(1);
    expect(result.ok).toBe(0); // 可修未改不应同时算作正常
    expect(fs.readFileSync(path.join(dir, 'relay.strm'), 'utf8')).toBe(relay);
  });
});
