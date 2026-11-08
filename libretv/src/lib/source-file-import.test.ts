import { describe, expect, it } from 'vitest';
import { parseSourceFile, pickSourcesFor } from './source-file-import';

const VOD = 'https://a.example.com/api.php/provide/vod';
const VOD2 = 'https://b.example.com/api.php/provide/vod';
const LIVE = 'https://a.example.com/iptv.m3u';

const fullList = JSON.stringify({
  name: '示例源列表',
  sources: [
    { name: '站点A', url: VOD },
    { name: '站点B', url: VOD2 },
  ],
  liveSources: [
    { name: '直播A', url: LIVE },
    { name: '直播B', url: 'https://b.example.com/cn.m3u', epg: 'https://b.example.com/epg.xml' },
  ],
});

describe('parseSourceFile · 点播与直播分开导入', () => {
  it('同一份完整列表：点播面板只数点播，另一半计入 otherCount', () => {
    const parsed = parseSourceFile(fullList, 'vod');
    expect(parsed.ownCount).toBe(2);
    expect(parsed.otherCount).toBe(2);
    expect(parsed.payload.sources.map((s) => s.name)).toEqual(['站点A', '站点B']);
  });

  it('同一份完整列表：直播面板只数直播，另一半计入 otherCount', () => {
    const parsed = parseSourceFile(fullList, 'live');
    expect(parsed.ownCount).toBe(2);
    expect(parsed.otherCount).toBe(2);
    expect(parsed.payload.liveSources.map((s) => s.url)).toEqual([
      LIVE,
      'https://b.example.com/cn.m3u',
    ]);
  });

  it('pickSourcesFor 只交出本面板那一半', () => {
    const parsed = parseSourceFile(fullList, 'vod');
    expect(pickSourcesFor(parsed, 'vod').live).toEqual([]);
    expect(pickSourcesFor(parsed, 'vod').vod).toHaveLength(2);

    const liveParsed = parseSourceFile(fullList, 'live');
    expect(pickSourcesFor(liveParsed, 'live').vod).toEqual([]);
    expect(pickSourcesFor(liveParsed, 'live').live).toHaveLength(2);
  });

  it('文件里只有另一种源时，报错并指路到对面面板', () => {
    const onlyLive = JSON.stringify({ liveSources: [{ name: '直播A', url: LIVE }] });
    expect(() => parseSourceFile(onlyLive, 'vod')).toThrow(/只有 1 个直播源.*「直播源」面板/);

    const onlyVod = JSON.stringify({ sources: [{ name: '站点A', url: VOD }] });
    expect(() => parseSourceFile(onlyVod, 'live')).toThrow(/只有 1 个点播源.*「点播源」面板/);
  });
});

describe('parseSourceFile · 裸数组按面板解释', () => {
  it('直播面板把裸数组当直播源（不是采集站）', () => {
    const text = JSON.stringify([{ name: '直播A', url: LIVE, epg: 'https://a.example.com/e.xml' }]);
    const parsed = parseSourceFile(text, 'live');
    expect(parsed.ownCount).toBe(1);
    expect(parsed.otherCount).toBe(0);
    expect(parsed.payload.liveSources[0]).toEqual({
      name: '直播A',
      url: LIVE,
      epg: 'https://a.example.com/e.xml',
    });
  });

  it('点播面板把裸数组当采集站', () => {
    const text = JSON.stringify([{ name: '站点A', url: VOD }]);
    const parsed = parseSourceFile(text, 'vod');
    expect(parsed.ownCount).toBe(1);
    expect(parsed.payload.sources[0].url).toBe(VOD);
  });

  it('接口目录（baseUrl）在点播面板仍可导入', () => {
    const text = JSON.stringify([{ name: '站点A', baseUrl: VOD }]);
    const parsed = parseSourceFile(text, 'vod');
    expect(parsed.ownCount).toBe(1);
    expect(parsed.payload.sources[0].url).toBe(VOD);
  });

  it('直播裸数组里地址不合法的条目被丢弃', () => {
    const text = JSON.stringify([
      { name: 'ok', url: LIVE },
      { name: 'bad', url: 'ftp://x/y.m3u' },
      { name: 'dup', url: LIVE },
    ]);
    const parsed = parseSourceFile(text, 'live');
    expect(parsed.ownCount).toBe(1);
  });
});

describe('parseSourceFile · TVBOX 配置', () => {
  it('sites 进点播、lives 进直播', () => {
    const text = JSON.stringify({
      sites: [{ key: 'a', name: '站点A', type: 1, api: VOD }],
      lives: [{ name: '直播A', url: LIVE }],
    });
    const vod = parseSourceFile(text, 'vod');
    expect(vod.ownCount).toBe(1);
    expect(vod.otherCount).toBe(1);
    expect(vod.payload.sources[0].url).toBe(VOD);

    const live = parseSourceFile(text, 'live');
    expect(live.ownCount).toBe(1);
    expect(live.otherCount).toBe(1);
  });
});

describe('parseSourceFile · 边界与错误', () => {
  it('M3U 播放列表在直播面板被拦下并说明该怎么办', () => {
    const m3u = '#EXTM3U\n#EXTINF:-1,CCTV1\nhttp://x/live.m3u8\n';
    expect(() => parseSourceFile(m3u, 'live')).toThrow(/频道播放列表.*托管成 URL/);
  });

  it('M3U 播放列表在点播面板被拦下', () => {
    expect(() => parseSourceFile('#EXTM3U\nhttp://x/a.m3u8', 'vod')).toThrow(/频道播放列表/);
  });

  it('空文件报错', () => {
    expect(() => parseSourceFile('   \n ', 'vod')).toThrow(/文件是空的/);
  });

  it('非 JSON 报错', () => {
    expect(() => parseSourceFile('not json at all', 'vod')).toThrow(/不是合法的 JSON/);
  });

  it('BOM 不影响解析', () => {
    const parsed = parseSourceFile('\uFEFF' + fullList, 'vod');
    expect(parsed.ownCount).toBe(2);
  });

  it('带注释与尾随逗号的 JSON 也能解析（沿用订阅的宽容解析）', () => {
    const text = `{
      // 注释
      "sources": [{"name": "站点A", "url": "${VOD}"},],
    }`;
    const parsed = parseSourceFile(text, 'vod');
    expect(parsed.ownCount).toBe(1);
  });

  it('空 sources 数组按格式错误报出', () => {
    expect(() => parseSourceFile(JSON.stringify({ sources: [] }), 'vod')).toThrow(
      /格式不正确/
    );
  });
});
