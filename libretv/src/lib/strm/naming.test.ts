import { describe, expect, it } from 'vitest';
import { parseSeasonEpisode, renderTemplate, sanitizeFileName, stripQualityTags } from './naming';

describe('sanitizeFileName', () => {
  it('移除路径非法字符并压缩空白', () => {
    expect(sanitizeFileName('斗罗/大陆:序?')).toBe('斗罗 大陆 序');
  });
  it('空结果有兜底', () => {
    expect(sanitizeFileName('///')).toBe('未命名');
  });
  it('超长截断', () => {
    expect(sanitizeFileName('a'.repeat(200)).length).toBe(120);
  });
});

describe('stripQualityTags', () => {
  it('去掉画质/语言标签', () => {
    expect(stripQualityTags('斗罗大陆 HD 国语中字')).toBe('斗罗大陆');
  });
});

describe('parseSeasonEpisode', () => {
  it('识别第N季第N集', () => {
    expect(parseSeasonEpisode('第2季第10集')).toEqual({ season: 2, episode: 10 });
  });
  it('识别中文季号', () => {
    expect(parseSeasonEpisode('第三季 第5集')).toEqual({ season: 3, episode: 5 });
  });
  it('识别 Season/EP 形式', () => {
    expect(parseSeasonEpisode('Season 1 EP07')).toEqual({ season: 1, episode: 7 });
    expect(parseSeasonEpisode('S02E12')).toEqual({ season: 2, episode: 12 });
  });
  it('仅集号时季默认 1', () => {
    expect(parseSeasonEpisode('第24集')).toEqual({ season: 1, episode: 24 });
  });
  it('结尾数字兜底', () => {
    expect(parseSeasonEpisode('05')).toEqual({ season: 1, episode: 5 });
  });
  it('无集数信息返回 undefined', () => {
    expect(parseSeasonEpisode('HD中字版')).toBeUndefined();
    expect(parseSeasonEpisode('正片')).toBeUndefined();
  });
});

describe('renderTemplate', () => {
  it('替换基础占位符', () => {
    expect(renderTemplate('{title} ({year})', { title: '斗罗', year: '2021' })).toBe('斗罗 (2021)');
  });
  it('年份非法时留空', () => {
    expect(renderTemplate('{title} ({year})', { title: '斗罗', year: '未知' })).toBe('斗罗 ()');
  });
  it('补零格式', () => {
    expect(
      renderTemplate('{title} S{season:02d}E{episode:02d}', { title: '斗罗', season: 1, episode: 5 })
    ).toBe('斗罗 S01E05');
  });
});
