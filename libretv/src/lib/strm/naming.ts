/** 命名与季集解析：模板渲染、文件名清洗、季/集号识别 */

const ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 清洗为合法文件名：去非法字符、压缩空白、限长 */
export function sanitizeFileName(name: string, maxLen = 120): string {
  const cleaned = name
    .replace(ILLEGAL_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return cleaned.slice(0, maxLen).trim() || '未命名';
}

const CN_NUM: Record<string, number | undefined> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 中文数字 → 阿拉伯数字（支持 0-99，如 十二→12、二十→20、二十三→23） */
function cnNumToInt(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  if (s === '十') return 10;
  const tenMatch = s.match(/^(.?)十(.?)$/);
  if (tenMatch) {
    const tens = tenMatch[1] ? CN_NUM[tenMatch[1]] : 1;
    const ones = tenMatch[2] ? CN_NUM[tenMatch[2]] : 0;
    if (tens !== undefined && ones !== undefined && tens <= 9) return tens * 10 + ones;
  }
  return CN_NUM[s];
}

export interface SeasonEpisode {
  season: number;
  episode: number;
}

/**
 * 从分集名解析季/集号。
 * 识别「第3季」「Season 2」「S02E12」「第01集」「EP05」「05」等常见形式；
 * 识别不出集号时 episode 为 0（调用方按单集影片处理）。
 */
export function parseSeasonEpisode(name: string): SeasonEpisode | undefined {
  const seasonMatch = name.match(/第\s*([0-9]+|[零一二三四五六七八九十两]+)\s*[季部]/i)
    ?? name.match(/season\s*([0-9]+)/i)
    ?? name.match(/\bS(\d{1,2})E/i);
  const episodeMatch = name.match(/第\s*([0-9]+)\s*[集话話期]/i)
    ?? name.match(/\bEP?\s*\.?\s*([0-9]+)/i)
    ?? name.match(/([0-9]{1,3})\s*$/);
  const season = seasonMatch ? cnNumToInt(seasonMatch[1]) : undefined;
  const episode = episodeMatch ? Number.parseInt(episodeMatch[1], 10) : undefined;
  if (episode === undefined && season === undefined) return undefined;
  if (episode !== undefined && episode <= 0) return undefined;
  return { season: season && season > 0 ? season : 1, episode: episode ?? 0 };
}

/** 渲染命名模板：支持 {title} {year} {season} {episode} {source} 与 {:0Nd} 补零 */
export function renderTemplate(
  template: string,
  vars: { title: string; year?: string; season?: number; episode?: number; source?: string }
): string {
  const year = vars.year && /^\d{4}$/.test(vars.year) ? vars.year : '';
  return template.replace(/\{(\w+)(?::(0\d*d?))?\}/g, (_m, key: string, pad?: string) => {
    let value: string;
    switch (key) {
      case 'title': value = vars.title; break;
      case 'year': value = year; break;
      case 'season': value = String(vars.season ?? 1); break;
      case 'episode': value = String(vars.episode ?? 0); break;
      case 'source': value = vars.source ?? ''; break;
      default: value = '';
    }
    if (pad && /^\d+$/.test(value)) {
      const width = Number.parseInt(pad.replace(/\D/g, ''), 10);
      if (width > 0) return value.padStart(width, '0');
    }
    return value;
  });
}

/** 去掉标题尾部的画质/来源标签，用于媒体库展示名（如「斗罗 HD」→「斗罗」） */
export function stripQualityTags(title: string): string {
  return title
    .replace(/\s*(HD|BD|超清|高清|蓝光|1080P|720P|4K|国语|中字|中英字幕|无删减|完整版|OVA|特别版)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
