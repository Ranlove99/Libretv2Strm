import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signStrmUrl, verifyStrmUrl } from './sign';
import { rewriteM3u8 } from './play';
import { buildEpisodeNfo, buildMovieNfo, buildTvShowNfo } from './nfo';
import { planGeneration, writeGeneration } from './generator';
import type { StrmConfig, VodDetail } from './types';

describe('sign/verify', () => {
  const url = 'https://example.com/a.m3u8';
  it('签名可通过校验', () => {
    expect(verifyStrmUrl(url, signStrmUrl(url))).toBe(true);
  });
  it('篡改地址或签名失败', () => {
    const sig = signStrmUrl(url);
    expect(verifyStrmUrl('https://evil.com/a.m3u8', sig)).toBe(false);
    expect(verifyStrmUrl(url, sig.slice(0, -1) + '0')).toBe(false);
    expect(verifyStrmUrl(url, null)).toBe(false);
  });
  it('无 PASSWORD 环境时也有稳定 secret', () => {
    delete process.env.PASSWORD;
    delete process.env.PROXY_SECRET;
    expect(signStrmUrl(url)).toBe(signStrmUrl(url));
  });
});

describe('rewriteM3u8', () => {
  it('重写分片地址并保留标签行', () => {
    const m3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXTINF:10,',
      'seg1.ts',
      'https://cdn.example.com/seg2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const out = rewriteM3u8(m3u8, new URL('https://host.example.com/vod/1/index.m3u8'));
    const lines = out.split('\n');
    expect(lines[0]).toBe('#EXTM3U');
    expect(lines[1]).toBe('#EXT-X-VERSION:3');
    expect(lines[2]).toBe('#EXT-X-TARGETDURATION:10');
    expect(lines[4]).toContain('/api/strm/play?u=');
    expect(decodeURIComponent(lines[4].split('u=')[1].split('&')[0])).toBe('https://host.example.com/vod/1/seg1.ts');
    expect(decodeURIComponent(lines[5].split('u=')[1].split('&')[0])).toBe('https://cdn.example.com/seg2.ts');
    expect(lines[6]).toBe('#EXT-X-ENDLIST');
  });

  it('重写 EXT-X-KEY 的 URI 属性', () => {
    const m3u8 = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.php?id=1"\nseg.ts';
    const out = rewriteM3u8(m3u8, new URL('https://host.example.com/vod/index.m3u8'));
    expect(out).toContain('URI="/api/strm/play?u=https%3A%2F%2Fhost.example.com%2Fvod%2Fkey.php%3Fid%3D1');
  });

  it('相对带查询串的分片地址正确解析', () => {
    const out = rewriteM3u8('#EXTM3U\nseg.ts?token=abc', new URL('https://h.com/a/b/index.m3u8'));
    expect(decodeURIComponent(out.split('u=')[1].split('&')[0])).toBe('https://h.com/a/b/seg.ts?token=abc');
  });
});

describe('NFO 生成', () => {
  const vod = {
    title: '斗罗大陆 & 序',
    year: '2021',
    typeName: '动漫,热血',
    area: '中国大陆',
    director: '张三',
    actor: '李四,王五',
    content: '简介 <b>加粗</b> "引号"',
  };
  it('movie.nfo 转义 XML', () => {
    const nfo = buildMovieNfo(vod);
    expect(nfo).toContain('<title>斗罗大陆 &amp; 序</title>');
    expect(nfo).toContain('简介 &lt;b&gt;加粗&lt;/b&gt; &quot;引号&quot;');
    expect(nfo).toContain('<genre>动漫</genre>');
    expect(nfo).toContain('<genre>热血</genre>');
    expect(nfo).toContain('<name>李四</name>');
    expect(nfo).toContain('<thumb aspect="poster">poster.jpg</thumb>');
  });
  it('tvshow.nfo 带季集统计', () => {
    const nfo = buildTvShowNfo(vod, 2, 26);
    expect(nfo).toContain('<season>2</season>');
    expect(nfo).toContain('<episode>26</episode>');
  });
  it('episode nfo 带单集信息', () => {
    const nfo = buildEpisodeNfo(vod, 1, 7, '第7集');
    expect(nfo).toContain('<title>第7集</title>');
    expect(nfo).toContain('<season>1</season>');
    expect(nfo).toContain('<episode>7</episode>');
  });
});

describe('writeGeneration 落盘', () => {
  let dir: string;
  const config: StrmConfig = {
    outputDir: '/tmp/unused',
    urlMode: 'direct',
    publicBaseUrl: '',
    movieTemplate: '{title} ({year})/{title} ({year})',
    tvTemplate: '{title} ({year})/Season {season}/{title} - S{season:02d}E{episode:02d}',
    generateNfo: true,
    downloadPoster: true,
    separateTv: true,
    concurrency: 2,
    maxEpisodes: 0,
    verifyAfterGenerate: false,
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strm-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('电影：strm + nfo + poster 齐全', async () => {
    const vod: VodDetail = {
      title: '测试电影',
      year: '2024',
      episodes: [{ name: '正片', url: 'https://example.com/a.mp4' }],
    };
    const written = await writeGeneration(
      planGeneration(vod, config),
      vod,
      config,
      dir,
      '',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    );
    const strm = written.find((w) => w.kind === 'strm');
    expect(strm?.file).toBe('电影/测试电影 (2024)/测试电影 (2024).strm');
    expect(fs.readFileSync(path.join(dir, strm!.file), 'utf8')).toBe('https://example.com/a.mp4');
    expect(fs.existsSync(path.join(dir, '电影/测试电影 (2024)/测试电影 (2024).nfo'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '电影/测试电影 (2024)/poster.jpg'))).toBe(true);
  });

  it('剧集：逐集 strm + nfo + 单个 tvshow.nfo', async () => {
    const vod: VodDetail = {
      title: '测试剧集',
      year: '2023',
      episodes: [
        { name: '第1集', url: 'https://example.com/1.m3u8' },
        { name: '第2集', url: 'https://example.com/2.m3u8' },
      ],
    };
    const written = await writeGeneration(planGeneration(vod, config), vod, config, dir, '', undefined);
    const strms = written.filter((w) => w.kind === 'strm');
    expect(strms).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, '电视剧/测试剧集 (2023)/tvshow.nfo'))).toBe(true);
    expect(written.filter((w) => w.file.endsWith('tvshow.nfo'))).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, '电视剧/测试剧集 (2023)/Season 1/测试剧集 - S01E01.nfo'))).toBe(true);
  });

  it('模板逃逸路径被拒绝', async () => {
    const vod: VodDetail = {
      title: '../../../etc/passwd',
      episodes: [{ name: '正片', url: 'https://example.com/a.mp4' }],
    };
    const evilConfig = { ...config, movieTemplate: '../../{title}/{title}' };
    await expect(
      writeGeneration(planGeneration(vod, evilConfig), vod, evilConfig, dir, '', undefined)
    ).rejects.toThrow('非法输出路径');
  });
});
