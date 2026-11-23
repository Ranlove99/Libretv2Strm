/**
 * Next.js 启动钩子：只做一件事——拉起 STRM 定时检查的进程内调度器。
 *
 * 只在 nodejs runtime 执行：调度器依赖 fs，edge 侧不需要也不能跑。
 * 用动态 import 保证 edge 产物不会把 node 模块打进去。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { ensureStrmScheduler } = await import('./lib/strm/scheduler');
  ensureStrmScheduler();
}
