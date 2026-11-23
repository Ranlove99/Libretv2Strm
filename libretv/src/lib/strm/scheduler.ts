/* STRM 定时检查的进程内调度器。
 *
 * 为什么不用 instrumentation 直接挂 setInterval：
 *   - 调度器依赖 fs / path，只能跑在 nodejs runtime；instrumentation 会被同时编译进
 *     edge 产物（本项目当前没有 middleware，但保留这条边界更稳），所以在 register()
 *     里按 NEXT_RUNTIME 判断后再动态 import。
 *   - 状态挂在 globalThis：规避多 chunk / dev 热重载导致的重复启动。
 *
 * 与外部 cron 的关系：本调度器只在应用进程内跑，不需要 crontab 或额外定时器；
 * 应用停止时自然不跑，重启后靠 auto.json 的 slot 去重与 6 小时补跑窗口续上。
 */

/* eslint-disable no-console */

import { autoTick } from './auto';
import { resumeInterruptedJobs } from './jobs';

/** 唤醒后延迟多久做第一次动作：等首屏渲染与数据目录就绪 */
const BOOT_DELAY = Number(process.env.LIBRETV_STRM_SCHEDULER_DELAY_MS || 8000);
/** 之后每分钟检查一次是否到点（每次开销仅一次配置读取） */
const TICK_MS = 60 * 1000;

interface SchedulerState {
  started: boolean;
  timer?: NodeJS.Timeout;
}

const STATE_KEY = '__LIBRETV_STRM_SCHEDULER__';

function state(): SchedulerState {
  const g = globalThis as unknown as Record<string, SchedulerState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { started: false };
  return g[STATE_KEY] as SchedulerState;
}

function unref(timer: NodeJS.Timeout | undefined): void {
  // 不阻止进程退出：停止 / 重启应用时能被正常终止
  if (timer && typeof timer.unref === 'function') timer.unref();
}

async function tick(): Promise<void> {
  try {
    await autoTick();
  } catch (err) {
    console.error('[strm-auto] 调度失败:', err);
  }
}

/**
 * 幂等启动。可在任意 nodejs runtime 的入口调用（instrumentation / API 路由），
 * 重复调用无副作用。设 LIBRETV_DISABLE_SCHEDULER=1 可关闭（本地调试用）。
 */
export function ensureStrmScheduler(): void {
  const s = state();
  if (s.started) return;
  s.started = true;

  if (process.env.LIBRETV_DISABLE_SCHEDULER === '1') {
    console.log('[strm-auto] 已通过 LIBRETV_DISABLE_SCHEDULER=1 关闭定时检查');
    return;
  }

  unref(
    setTimeout(() => {
      // 先接手上次没跑完的检查作业：用户最可能立刻打开页面看进度
      try {
        const r = resumeInterruptedJobs();
        if (r.resumed.length > 0) {
          console.log(`[strm-auto] 已接手 ${r.resumed.length} 个未完成的检查作业`);
        }
      } catch (err) {
        console.error('[strm-auto] 接手未完成作业失败:', err);
      }

      // 启动即补一次：应用晚于计划时刻启动时，靠补跑窗口当天仍会检查
      void tick();
      s.timer = setInterval(() => void tick(), TICK_MS);
      unref(s.timer);
      console.log('[strm-auto] 定时检查调度器已启动（每分钟检查一次是否到点）');
    }, BOOT_DELAY)
  );
}
