import fs from 'node:fs';
import path from 'node:path';
import type { StrmConfig } from './types';

/**
 * STRM 功能的服务端配置持久化。
 * 数据目录优先级：STRM_DATA_DIR 环境变量（fpk 安装时由 cmd 脚本指向 TRIM_PKGVAR）
 *  > TRIM_PKGVAR/strm（fnOS 环境兜底） > 进程工作目录/.data（本地开发）。
 */

export const STRM_CONFIG_VERSION = 2;

/** 落盘结构：StrmConfig + 配置版本号（用于一次性迁移） */
interface StoredStrmConfig extends Partial<StrmConfig> {
  configVersion?: number;
}

export function strmDataRoot(): string {
  if (process.env.STRM_DATA_DIR) return process.env.STRM_DATA_DIR;
  if (process.env.TRIM_PKGVAR) return path.join(process.env.TRIM_PKGVAR, 'strm');
  return path.join(process.cwd(), '.data');
}

function configFilePath(): string {
  return path.join(strmDataRoot(), 'config.json');
}

function defaultOutputDir(): string {
  // fnOS 安装时由 cmd 脚本注入：优先 data-share 共享目录（媒体服务器可直接扫描），
  // 共享目录不可用时退回应用数据目录
  if (process.env.STRM_DEFAULT_OUTPUT_DIR) return process.env.STRM_DEFAULT_OUTPUT_DIR;
  return path.join(strmDataRoot(), 'library');
}

/** 默认输出目录（供设置页「恢复默认」使用） */
export function getDefaultOutputDir(): string {
  return defaultOutputDir();
}

export function defaultStrmConfig(): StrmConfig {
  return {
    outputDir: defaultOutputDir(),
    // 默认走采集站直链：媒体服务器直接向上游取流，不经过本应用，
    // 因此不受 NAS 的域名 / 端口 / 中继可达性影响，也不消耗 NAS 上行带宽。
    // 仅当上游有防盗链（Referer 校验）时才需要切到 proxy 模式。
    urlMode: 'direct',
    publicBaseUrl: '',
    movieTemplate: '{title} ({year})/{title} ({year})',
    tvTemplate: '{title} ({year})/Season {season}/{title} - S{season:02d}E{episode:02d}',
    generateNfo: true,
    downloadPoster: true,
    separateTv: true,
    concurrency: 2,
    maxEpisodes: 0,
    verifyAfterGenerate: true,
  };
}

/** 归一化用户提交的配置：裁剪超长字符串、收敛枚举与数值范围 */
export function normalizeStrmConfig(input: Partial<StrmConfig>): StrmConfig {
  const d = defaultStrmConfig();
  const c: StrmConfig = { ...d };
  if (typeof input.outputDir === 'string' && input.outputDir.trim()) {
    c.outputDir = input.outputDir.trim().slice(0, 500);
  }
  if (input.urlMode === 'direct' || input.urlMode === 'proxy') c.urlMode = input.urlMode;
  if (typeof input.publicBaseUrl === 'string') {
    c.publicBaseUrl = input.publicBaseUrl.trim().slice(0, 200).replace(/\/+$/, '');
  }
  if (typeof input.movieTemplate === 'string' && input.movieTemplate.trim()) {
    c.movieTemplate = input.movieTemplate.trim().slice(0, 300);
  }
  if (typeof input.tvTemplate === 'string' && input.tvTemplate.trim()) {
    c.tvTemplate = input.tvTemplate.trim().slice(0, 300);
  }
  c.generateNfo = input.generateNfo !== false;
  c.downloadPoster = input.downloadPoster !== false;
  c.separateTv = input.separateTv !== false;
  const conc = Number.parseInt(String(input.concurrency ?? ''), 10);
  c.concurrency = Number.isFinite(conc) ? Math.min(5, Math.max(1, conc)) : d.concurrency;
  const maxEp = Number.parseInt(String(input.maxEpisodes ?? ''), 10);
  c.maxEpisodes = Number.isFinite(maxEp) ? Math.min(5000, Math.max(0, maxEp)) : 0;
  c.verifyAfterGenerate = input.verifyAfterGenerate !== false;
  return c;
}

let cache: StrmConfig | null = null;
/** 一次性迁移提示：只在本次进程内第一次读取时返回给前端，避免反复弹窗 */
let migrationNotice: string | null = null;

/** 取走（并清空）一次性迁移提示 */
export function takeStrmMigrationNotice(): string | null {
  const notice = migrationNotice;
  migrationNotice = null;
  return notice;
}

/**
 * 存量配置迁移。
 * v1 → v2：URL 模式默认值由 proxy 改为 direct（采集站直链）。
 * 旧版本把 proxy 当作默认值写进 config.json，无法区分「默认写入」与「用户主动选择」，
 * 因此统一切成 direct——直链不依赖 NAS 的可达性，是更稳妥的默认值；
 * 确有防盗链的源可在设置页一键切回代理模式（面板会提示本次已自动切换）。
 */
function migrateConfig(raw: StoredStrmConfig): { config: StrmConfig; migrated: boolean } {
  const config = normalizeStrmConfig(raw);
  const fromVersion = raw.configVersion ?? 1;
  if (fromVersion < 2 && raw.urlMode === 'proxy') {
    return { config: { ...config, urlMode: 'direct' }, migrated: true };
  }
  return { config, migrated: false };
}

export function getStrmConfig(): StrmConfig {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(configFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as StoredStrmConfig;
    const { config, migrated } = migrateConfig(parsed);
    cache = config;
    // 迁移结果立即回写：避免每次启动重复迁移，也让用户在设置页看到的与实际生效的一致
    if (migrated) {
      migrationNotice =
        '已按新版默认把 STRM 的 URL 模式从「经本站代理」切换为「采集站直链」：' +
        '直链不依赖 NAS 地址与中继是否可达，播放更省事。若某个源有防盗链导致 403，可在设置里切回代理模式。';
      try {
        persist(config);
      } catch {
        // 只读数据目录（极少见）时放弃回写，内存态依然正确
      }
    }
  } catch {
    cache = defaultStrmConfig();
  }
  return cache;
}

function persist(next: StrmConfig): void {
  fs.mkdirSync(strmDataRoot(), { recursive: true });
  const tmp = configFilePath() + '.tmp';
  const body: StoredStrmConfig = { configVersion: STRM_CONFIG_VERSION, ...next };
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, configFilePath());
}

export function saveStrmConfig(input: Partial<StrmConfig>): StrmConfig {
  const next = normalizeStrmConfig(input);
  persist(next);
  cache = next;
  return next;
}

/** 确保输出目录存在；失败时抛出可读错误（前端直接展示） */
export function ensureOutputDir(dir: string): string {
  if (!path.isAbsolute(dir)) {
    throw new Error('输出目录必须是绝对路径');
  }
  fs.mkdirSync(dir, { recursive: true });
  // 可写性校验：创建后立刻写一个探针文件，权限不足时尽早暴露
  const probe = path.join(dir, '.write-test');
  fs.writeFileSync(probe, '');
  fs.unlinkSync(probe);
  return dir;
}
