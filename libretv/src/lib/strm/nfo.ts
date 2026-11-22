/** NFO 刮削文件生成（Emby / Jellyfin 兼容格式） */

function esc(v: string | undefined): string {
  if (!v) return '';
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // 控制字符对 XML 非法
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function actorTags(actor: string | undefined): string {
  if (!actor) return '';
  return actor
    .split(/[,，/]/)
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((a) => `  <actor>\n   <name>${esc(a)}</name>\n   <role/>\n  </actor>`)
    .join('\n');
}

function genreTags(typeName: string | undefined, area: string | undefined): string {
  const tags: string[] = [];
  if (typeName) tags.push(...typeName.split(/[,，/ ]+/).map((t) => t.trim()).filter(Boolean));
  if (area) tags.push(area.trim());
  return [...new Set(tags)]
    .slice(0, 8)
    .map((t) => `  <genre>${esc(t)}</genre>`)
    .join('\n');
}

/** 电影 NFO：与同名 strm 同目录，文件名 movie.nfo */
export function buildMovieNfo(vod: {
  title: string;
  year?: string;
  typeName?: string;
  area?: string;
  director?: string;
  actor?: string;
  content?: string;
  remarks?: string;
}): string {
  const year = vod.year && /^\d{4}$/.test(vod.year) ? vod.year : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>${esc(vod.title)}</title>
  <originaltitle></originaltitle>
  <year>${esc(year)}</year>
  <plot>${esc(vod.content)}</plot>
  <outline></outline>
  <runtime>0</runtime>
  ${genreTags(vod.typeName, vod.area)}
  <country>${esc(vod.area)}</country>
  <director>${esc(vod.director)}</director>
${actorTags(vod.actor)}
  <thumb aspect="poster">poster.jpg</thumb>
  <fanart/>
</movie>`;
}

/** 剧集 NFO：位于剧集根目录，文件名 tvshow.nfo */
export function buildTvShowNfo(vod: {
  title: string;
  year?: string;
  typeName?: string;
  area?: string;
  director?: string;
  actor?: string;
  content?: string;
}, season: number, episodeCount: number): string {
  const year = vod.year && /^\d{4}$/.test(vod.year) ? vod.year : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>${esc(vod.title)}</title>
  <originaltitle></originaltitle>
  <year>${esc(year)}</year>
  <plot>${esc(vod.content)}</plot>
  ${genreTags(vod.typeName, vod.area)}
  <country>${esc(vod.area)}</country>
  <director>${esc(vod.director)}</director>
${actorTags(vod.actor)}
  <thumb aspect="poster">poster.jpg</thumb>
  <season>${season}</season>
  <episode>${episodeCount}</episode>
</tvshow>`;
}

/** 单集 NFO：与单集 strm 同目录 */
export function buildEpisodeNfo(vod: {
  title: string;
  content?: string;
}, season: number, episode: number, epName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>${esc(epName || vod.title)}</title>
  <showtitle>${esc(vod.title)}</showtitle>
  <season>${season}</season>
  <episode>${episode}</episode>
  <plot>${esc(vod.content)}</plot>
  <thumb></thumb>
</episodedetails>`;
}
