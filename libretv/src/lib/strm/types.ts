/** STRM 媒体库生成功能：类型定义 */

/**
 * URL 写入模式：
 * - direct（默认）= 采集站原始地址，媒体服务器直连上游取流，不经过本应用；
 * - proxy = 经本站 /api/strm/play 代理（防盗链 + m3u8 重写），需要媒体服务器能访问本站地址。
 */
export type StrmUrlMode = 'direct' | 'proxy';

/** 服务端持久化配置（config.json） */
export interface StrmConfig {
  /** STRM 输出根目录（绝对路径） */
  outputDir: string;
  /** strm 文件内容模式 */
  urlMode: StrmUrlMode;
  /**
   * 代理模式对外地址，如 http://192.168.1.10:8080。
   * 留空时用创建任务请求的 Host 头推导；跨网段访问的媒体服务器建议显式填写。
   */
  publicBaseUrl: string;
  /** 电影目录/文件命名模板，占位符 {title} {year} */
  movieTemplate: string;
  /** 剧集命名模板，占位符 {title} {year} {season} {episode} */
  tvTemplate: string;
  /** 是否生成 NFO 刮削文件 */
  generateNfo: boolean;
  /** 是否下载海报（poster.jpg） */
  downloadPoster: boolean;
  /** 电影/剧集是否分顶层目录存放 */
  separateTv: boolean;
  /** 任务内并发处理的影片数（1-5） */
  concurrency: number;
  /** 单影片生成的集数上限（0=不限） */
  maxEpisodes: number;
  /** 生成完成后自动测试每个 .strm 的播放地址有效性 */
  verifyAfterGenerate: boolean;
  /** 每天定时检查 .strm 可用性（由进程内调度器触发，不依赖外部 cron） */
  autoCheck: boolean;
  /** 执行频率：daily=按天（可多天间隔）/ interval=按小时间隔 */
  autoCheckMode: 'daily' | 'interval';
  /** daily 模式的执行时刻（本机时间 HH:mm） */
  autoCheckAt: string;
  /** daily 模式的天间隔：1=每天，2=每两天… */
  autoCheckEveryDays: number;
  /** interval 模式的间隔小时数 */
  autoCheckEveryHours: number;
  /** 检查发现失效后自动回源重取地址（深度修复） */
  autoFix: boolean;
}

/** 单集有效性测试结果：ok=可播放；fail=不可用（附原因）；skipped=未测试 */
export type StrmVerifyStatus = 'ok' | 'fail' | 'skipped';

/** 生成任务中的单集结果 */
export interface StrmTaskEpisode {
  name: string;
  /** 生成的 .strm 文件相对输出目录的路径；未生成（失败/跳过）时为空 */
  file?: string;
  error?: string;
  /** 有效性测试结果（verifyAfterGenerate 开启时） */
  verify?: StrmVerifyStatus;
  verifyError?: string;
}

/** 生成任务中的单个影片 */
export interface StrmTaskItem {
  sourceKey: string;
  sourceName: string;
  /** 采集站 API 地址（详情请求需要） */
  sourceUrl: string;
  vodId: string;
  title: string;
  year?: string;
  typeName?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  episodes: StrmTaskEpisode[];
  error?: string;
}

export type StrmTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

/** 生成任务（tasks.json 持久化） */
export interface StrmTask {
  id: string;
  title: string;
  status: StrmTaskStatus;
  total: number;
  done: number;
  failed: number;
  items: StrmTaskItem[];
  createdAt: number;
  finishedAt?: number;
  /** 创建任务时推断的对外地址（publicBaseUrl 为空时兜底） */
  baseUrl?: string;
  /**
   * 对外地址被自动纠正时的提示。
   * 典型：浏览器经 FN Connect 中继访问（Host=*.fnos.net）时，中继域名无法被
   * 媒体服务器/播放器访问，服务端自动改用局域网地址，此处记录原因。
   */
  warning?: string;
}

/** 采集站分类（根接口 class 数组） */
export interface CatalogClass {
  id: string;
  name: string;
}

/** 采集站视频条目（列表/搜索结果共用） */
export interface CatalogVideo {
  vodId: string;
  name: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
}

/** 影片完整详情（含分集名与地址对） */
export interface VodDetail {
  title: string;
  year?: string;
  typeName?: string;
  area?: string;
  director?: string;
  actor?: string;
  content?: string;
  pic?: string;
  remarks?: string;
  episodes: { name: string; url: string }[];
}

/** 输出目录文件条目（/api/strm/files） */
export interface StrmFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** /api/strm/play 的 m3u8 重写上下文 */
export interface RewriteContext {
  /** m3u8 自身的最终 URL（解析相对分片地址） */
  base: URL;
}

/** STRM 检查发现的问题类型 */
export type StrmIssueCode =
  | 'empty' // 文件为空
  | 'not-url' // 内容不是 http(s) 地址
  | 'whitespace' // 首尾空白 / BOM（可无损修复）
  | 'proxy-missing-sig' // 代理地址缺签名
  | 'proxy-bad-sig' // 签名与当前密钥不匹配（改过密码）
  | 'proxy-relay-base' // 代理地址用了 FN Connect 中继域名
  | 'proxy-stale-lan-base' // 代理地址指向已失效的旧局域网 IP
  | 'proxy-bad-target' // 代理地址缺少有效的上游目标
  | 'direct-relay-host' // 直链指向中继域名
  | 'unreadable'; // 文件读取失败

/** 单个 .strm 文件的检查结果 */
export interface StrmRepairDetail {
  /** 相对输出目录的路径 */
  file: string;
  kind: 'direct' | 'proxy' | 'invalid';
  issues: StrmIssueCode[];
  /** 已做结构修复 */
  fixed?: boolean;
  /** 已做深度修复（回源重取地址） */
  deepFixed?: boolean;
  /** 无法修复的原因 */
  reason?: string;
  verify?: StrmVerifyStatus;
  verifyError?: string;
}

/** /api/strm/files/repair 的返回 */
export interface StrmRepairResult {
  root: string;
  /** 扫描到的 .strm 数量 */
  scanned: number;
  /** 结构正常（无需改动） */
  ok: number;
  /** 结构修复成功 */
  fixed: number;
  /** 深度修复成功 */
  deepFixed: number;
  /** 修复后仍不可用 */
  unfixable: number;
  /** 可修但本次为只读检查、未写入 */
  pendingRepair: number;
  /** 最终验证失败数 */
  verifyFailed: number;
  /** 是否因数量上限截断 */
  truncated: boolean;
  /** 有问题的文件明细（已截断） */
  details: StrmRepairDetail[];
}

/** 一次自动检查的统计快照（auto.json 落盘，供面板展示） */
export interface StrmAutoStats {
  scanned: number;
  ok: number;
  fixed: number;
  deepFixed: number;
  unfixable: number;
  verifyFailed: number;
  truncated: boolean;
}

/** 自动检查的运行状态（auto.json 落盘；进程重启不丢「今天跑过」） */
export interface StrmAutoState {
  /** 最近一次执行的时段 'YYYY-MM-DD HH:mm'，用于同一天不重复跑 */
  lastSlot?: string;
  /** 最近一次开始时间 */
  lastRunAt?: number;
  /** 最近一次结束时间 */
  lastFinishedAt?: number;
  /** 结果文案（一行摘要） */
  lastResult?: string;
  /** 结果统计 */
  lastStats?: StrmAutoStats;
  /** 失败原因（成功时清空） */
  lastError?: string;
}

/** /api/strm/auto 的返回：配置 + 状态合成的一条摘要 */
export interface StrmAutoSummary {
  enabled: boolean;
  mode: 'daily' | 'interval';
  /** daily 模式的执行时刻 HH:mm */
  at: string;
  /** daily 模式的天间隔 */
  everyDays: number;
  /** interval 模式的间隔小时数 */
  everyHours: number;
  /** 是否开启自动修复 */
  fix: boolean;
  /** 下次执行时间戳；未开启为 null */
  nextAt: number | null;
  /** 正在后台执行的作业（没有则不返回） */
  activeJob?: StrmJobBrief;
  lastRunAt?: number;
  lastFinishedAt?: number;
  lastResult?: string;
  lastError?: string;
  lastStats?: StrmAutoStats;
}

/** 作业摘要：只需要进度的地方用它 */
export interface StrmJobBrief {
  id: string;
  trigger: 'manual' | 'auto';
  done: number;
  total: number;
  startedAt?: number;
  current?: string;
}

/** 后台检查作业的状态 */
export type StrmJobStatus = 'running' | 'paused' | 'done' | 'failed' | 'canceled';

/** 作业里单个文件的处理结果 */
export interface StrmJobFile {
  file: string;
  state: 'pending' | 'ok' | 'fixed' | 'deep-fixed' | 'fail';
  issues?: StrmIssueCode[];
  reason?: string;
  verify?: StrmVerifyStatus;
  verifyError?: string;
}

/**
 * 后台检查作业（jobs.json 落盘）。
 * 文件清单与每个文件的状态都在这里：页面只是观察者，关掉不影响执行；
 * 进程重启后按未完成的项续跑。
 */
export interface StrmJob {
  id: string;
  status: StrmJobStatus;
  /** manual=用户点击 / auto=定时任务 */
  trigger: 'manual' | 'auto';
  options: { repair: boolean; deep: boolean; verify: boolean };
  total: number;
  done: number;
  ok: number;
  fixed: number;
  deepFixed: number;
  fail: number;
  pendingRepair: number;
  verifyFailed: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 心跳：进程异常退出后据此判定中断 */
  heartbeatAt: number;
  /** 自动续跑次数，防止「一启动就崩」的循环 */
  resumeCount: number;
  /** 暂停来源：用户主动暂停的作业不会被自动接手 */
  pausedBy?: 'user' | 'restart';
  note?: string;
  /** 最近处理的文件（进度展示） */
  current?: string;
  files: StrmJobFile[];
}

/** /api/strm/jobs 返回的作业视图（明细已裁剪） */
export interface StrmJobView {
  id: string;
  status: StrmJobStatus;
  trigger: 'manual' | 'auto';
  options: { repair: boolean; deep: boolean; verify: boolean };
  total: number;
  done: number;
  ok: number;
  fixed: number;
  deepFixed: number;
  fail: number;
  pendingRepair: number;
  verifyFailed: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  ms?: number;
  note?: string;
  current?: string;
  /** 有问题的文件明细（截断） */
  problems: StrmJobFile[];
  problemsTotal: number;
  /** 尚未处理的文件数（暂停/中断时可继续） */
  remaining: number;
}
