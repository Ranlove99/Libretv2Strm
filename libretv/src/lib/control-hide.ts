/**
 * 控制栏自动隐藏策略（ArtPlayer.CONTROL_HIDE_TIME，全局 static）。
 *
 * 该值是共享状态：恢复时一律回到**库默认值**而不是「进入时的快照」——
 * 点播 / 直播两个播放器先后挂载时，快照可能已经是被上一个组件改过的值
 * （如触屏设为 MAX_SAFE_INTEGER），互相污染会把「触屏常驻」泄漏到桌面。
 * 本应用是唯一写入方，库默认值即安全基准。
 */
export const ART_DEFAULT_CONTROL_HIDE_MS = 3000;
/** 桌面：鼠标停止移动 / 离开播放器后快速收起（历史默认值，仍作为设置的缺省档） */
export const DESKTOP_CONTROL_HIDE_MS = 800;
/**
 * 触屏：永不自动隐藏（issue LibreSpark/LibreTV#937）。
 * ArtPlayer 的判定是 `Date.now() - timer >= CONTROL_HIDE_TIME`，该差值是毫秒级，
 * 恒小于 MAX_SAFE_INTEGER，因此自动隐藏永不触发——由「点按视频 toggle」收起。
 */
export const TOUCH_CONTROL_HIDE_MS = Number.MAX_SAFE_INTEGER;

/** 「不自动隐藏」在设置里的取值（毫秒），与 ArtPlayer 的「永不到期」语义对齐 */
export const CONTROL_HIDE_NEVER = 0;

/** 允许的取值范围：太短会「闪一下就没」，太长等于没隐藏 */
export const CONTROL_HIDE_MIN_MS = 200;
export const CONTROL_HIDE_MAX_MS = 60000;

/**
 * 设置面板的可选档位（毫秒）。
 * 800 是历史默认值，保留它让存量用户升级后行为完全不变。
 */
export const CONTROL_HIDE_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: 500, label: '0.5 秒', hint: '反应最快，控制栏几乎一移开就收起' },
  { value: DESKTOP_CONTROL_HIDE_MS, label: '0.8 秒（默认）', hint: '鼠标一离开就收，兼顾顺手与不挡画面' },
  { value: 1000, label: '1 秒', hint: '比默认稍缓，给「移开又移回」留一点余量' },
  { value: 1500, label: '1.5 秒', hint: '从容一些，适合控制栏需要反复点选的场景' },
  { value: 2000, label: '2 秒', hint: '偏慢，适合边看边操作' },
  { value: 3000, label: '3 秒', hint: '与 ArtPlayer 原生默认一致' },
  { value: 5000, label: '5 秒', hint: '几乎一直挂着，只在长时间不动时收起' },
  { value: CONTROL_HIDE_NEVER, label: '不自动隐藏', hint: '控制栏常驻，需要手动点一下视频才收起（触屏也是这个行为）' },
];

/**
 * 把设置里的原始值收敛为合法毫秒数。
 * 非法值（缺失 / NaN / 负数）一律回落到默认档，避免旧版本 localStorage 里的脏数据
 * 把控制栏变成「永不隐藏」或「立刻消失」。
 */
export function resolveControlHideMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DESKTOP_CONTROL_HIDE_MS;
  if (raw === CONTROL_HIDE_NEVER) return CONTROL_HIDE_NEVER;
  if (raw < 0) return DESKTOP_CONTROL_HIDE_MS;
  return Math.min(Math.max(Math.round(raw), CONTROL_HIDE_MIN_MS), CONTROL_HIDE_MAX_MS);
}

/**
 * 把「毫秒延迟」翻译成 ArtPlayer 的 CONTROL_HIDE_TIME。
 * 0（不自动隐藏）要映射成 MAX_SAFE_INTEGER —— ArtPlayer 只认「差值是否已超过该值」，
 * 没有独立的「关闭」开关。
 */
export function artControlHideTime(ms: number): number {
  return ms === CONTROL_HIDE_NEVER ? TOUCH_CONTROL_HIDE_MS : ms;
}
