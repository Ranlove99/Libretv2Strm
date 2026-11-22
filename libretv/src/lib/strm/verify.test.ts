import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyItemEpisodes, verifyStrmFile } from './verify';
import type { StrmTaskEpisode } from './types';

/** 有效性测试：通过 stub global.fetch 模拟上游行为 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'strm-verify-'));
}

function writeStrm(dir: string, rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const okM3u8 = '#EXTM3U\n#EXTINF:5,\nseg0.ts\n';

describe('verifyStrmFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('m3u8 内容含 #EXTM3U 判定有效', async () => {
    const dir = tmpDir();
    const abs = writeStrm(dir, 'a.strm', 'https://up.example/v/index.m3u8');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(okM3u8, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }))
    );
    const r = await verifyStrmFile(abs);
    expect(r.verify).toBe('ok');
  });

  it('m3u8 内容异常判定失败', async () => {
    const dir = tmpDir();
    const abs = writeStrm(dir, 'b.strm', 'https://up.example/v/index.m3u8');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not a playlist', { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }))
    );
    const r = await verifyStrmFile(abs);
    expect(r.verify).toBe('fail');
    expect(r.verifyError).toContain('播放列表无效');
  });

  it('非 m3u8 直链 200 即有效', async () => {
    const dir = tmpDir();
    const abs = writeStrm(dir, 'c.strm', 'https://up.example/v/movie.mp4');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(1024), { status: 200, headers: { 'Content-Type': 'video/mp4' } }))
    );
    const r = await verifyStrmFile(abs);
    expect(r.verify).toBe('ok');
  });

  it('HTTP 非 200 判定失败并带状态码', async () => {
    const dir = tmpDir();
    const abs = writeStrm(dir, 'd.strm', 'https://up.example/v/index.m3u8');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404 }))
    );
    const r = await verifyStrmFile(abs);
    expect(r.verify).toBe('fail');
    expect(r.verifyError).toBe('HTTP 404');
  });

  it('网络异常判定失败', async () => {
    const dir = tmpDir();
    const abs = writeStrm(dir, 'e.strm', 'https://up.example/v/index.m3u8');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      })
    );
    const r = await verifyStrmFile(abs);
    expect(r.verify).toBe('fail');
    expect(r.verifyError).toBe('ECONNRESET');
  });

  it('strm 内容不是 http 地址判定失败', async () => {
    const dir = tmpDir();
    const abs = writeStrm(dir, 'f.strm', 'not-a-url');
    const r = await verifyStrmFile(abs);
    expect(r.verify).toBe('fail');
    expect(r.verifyError).toContain('地址无效');
  });

  it('文件不存在判定失败', async () => {
    const r = await verifyStrmFile(path.join(tmpDir(), 'missing.strm'));
    expect(r.verify).toBe('fail');
    expect(r.verifyError).toContain('文件读取失败');
  });
});

describe('verifyItemEpisodes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('逐集写入验证结果；无 file 的集标记 skipped', async () => {
    const dir = tmpDir();
    writeStrm(dir, 'show/S01E01.strm', 'https://up.example/1.m3u8');
    writeStrm(dir, 'show/S01E02.strm', 'https://up.example/2.m3u8');
    const episodes: StrmTaskEpisode[] = [
      { name: '第1集', file: 'show/S01E01.strm' },
      { name: '第2集', file: 'show/S01E02.strm' },
      { name: '第3集' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith('2.m3u8')
          ? new Response('broken', { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
          : new Response(okM3u8, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
      )
    );
    await verifyItemEpisodes(episodes, dir);
    expect(episodes[0].verify).toBe('ok');
    expect(episodes[1].verify).toBe('fail');
    expect(episodes[2].verify).toBe('skipped');
  });

  it('拒绝目录逃逸路径（.. 跳出输出目录）', async () => {
    const dir = tmpDir();
    const outside = tmpDir();
    const outsideFile = writeStrm(outside, 'evil.strm', 'https://up.example/x.m3u8');
    const episodes: StrmTaskEpisode[] = [{ name: '逃逸集', file: path.join('..', path.basename(outside), 'evil.strm') }];
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await verifyItemEpisodes(episodes, dir);
    expect(episodes[0].verify).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(outsideFile)).toBe(true);
  });
});
