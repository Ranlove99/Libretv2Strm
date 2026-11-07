'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useToast } from '@/components/toast';
import { Spinner, EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/utils';
import type { StrmTask, StrmTaskStatus } from '@/lib/strm/types';

/** 任务面板：轮询展示进度，支持取消 / 重试 / 删除 / 明细展开 */

const STATUS_LABEL: Record<StrmTaskStatus, string> = {
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
};

const STATUS_STYLE: Record<StrmTaskStatus, string> = {
  queued: 'bg-chip text-muted',
  running: 'bg-info-solid text-white',
  done: 'bg-success-solid text-white',
  failed: 'bg-danger-solid text-white',
  canceled: 'bg-chip text-muted',
};

const POLL_INTERVAL = 2000;

export function StrmTasksPanel() {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState('');

  const tasksQuery = useQuery({
    queryKey: ['strm-tasks'],
    queryFn: () => api.strmTasks(),
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasActive = data?.tasks.some((t) => t.status === 'running' || t.status === 'queued');
      return hasActive ? POLL_INTERVAL : false;
    },
  });

  const tasks = tasksQuery.data?.tasks ?? [];

  const act = useCallback(
    async (id: string, action: 'cancel' | 'retry' | 'delete') => {
      setBusyId(id);
      try {
        if (action === 'cancel') await api.cancelStrmTask(id);
        else if (action === 'retry') await api.retryStrmTask(id);
        else await api.deleteStrmTask(id);
        await tasksQuery.refetch();
      } catch (err) {
        toast(err instanceof Error ? err.message : '操作失败', 'error');
      } finally {
        setBusyId('');
      }
    },
    [tasksQuery, toast]
  );

  if (tasksQuery.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (tasksQuery.error) {
    return <EmptyState title="任务列表加载失败" description={tasksQuery.error.message} />;
  }
  if (tasks.length === 0) {
    return <EmptyState title="暂无生成任务" description="在「生成媒体库」页选择影片后创建任务" />;
  }

  return (
    <div className="space-y-4">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          busy={busyId === task.id}
          expanded={expanded === task.id}
          onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
          onAct={(a) => void act(task.id, a)}
        />
      ))}
    </div>
  );
}

function TaskCard({
  task,
  busy,
  expanded,
  onToggle,
  onAct,
}: {
  task: StrmTask;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onAct: (action: 'cancel' | 'retry' | 'delete') => void;
}) {
  const percent = task.total > 0 ? Math.round(((task.done + task.failed) / task.total) * 100) : 0;
  const active = task.status === 'running' || task.status === 'queued';

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-start gap-3">
        <button className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate max-w-[60vw] sm:max-w-none">{task.title}</span>
            <span className={cn('badge', STATUS_STYLE[task.status])}>{STATUS_LABEL[task.status]}</span>
          </div>
          <div className="text-xs text-faint mt-0.5">
            {formatRelativeTime(task.createdAt)}创建 · 共 {task.total} 部 · 成功 {task.done} · 失败 {task.failed}
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {active && (
            <button className="btn-sm btn-secondary" disabled={busy} onClick={() => onAct('cancel')}>
              取消
            </button>
          )}
          {(task.status === 'failed' || task.status === 'canceled' || task.failed > 0) && (
            <button className="btn-sm btn-secondary" disabled={busy} onClick={() => onAct('retry')}>
              重试
            </button>
          )}
          {!active && (
            <button
              className="btn-sm btn-secondary text-danger"
              disabled={busy}
              onClick={() => onAct('delete')}
              aria-label="删除任务"
            >
              <Icon name="trash" />
            </button>
          )}
        </div>
      </div>

      <div className="h-1.5 bg-line rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            task.status === 'failed' ? 'bg-danger' : 'bg-accent'
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      {expanded && (
        <ul className="divide-y divide-line text-xs">
          {task.items.map((item, i) => (
            <li key={`${item.sourceUrl}|${item.vodId}|${i}`} className="py-2">
              <div className="flex items-center gap-2">
                <StatusDot status={item.status} />
                <span className="truncate flex-1">{item.title}</span>
                <span className="text-faint shrink-0">{item.sourceName}</span>
              </div>
              {item.error && <div className="text-danger mt-0.5 pl-5">{item.error}</div>}
              {item.episodes.length > 0 && (
                <div className="text-faint mt-0.5 pl-5 space-y-0.5">
                  <div>
                    {item.episodes.length} 集：{item.episodes[0].file}
                    {item.episodes.length > 1 && ` 等`}
                  </div>
                  {(() => {
                    // 有效性测试结果聚合（仅当存在测试数据时展示）
                    const tested = item.episodes.filter((e) => e.verify === 'ok' || e.verify === 'fail');
                    if (tested.length === 0) return null;
                    const failed = tested.filter((e) => e.verify === 'fail');
                    if (failed.length === 0) {
                      return <div className="text-success">✓ 已测试 {tested.length} 集，全部可播放</div>;
                    }
                    return (
                      <div className="text-warning">
                        ⚠ 已测试 {tested.length} 集，{failed.length} 集不可播放：
                        {failed
                          .slice(0, 3)
                          .map((e) => `${e.name}${e.verifyError ? `（${e.verifyError}）` : ''}`)
                          .join('、')}
                        {failed.length > 3 && ' 等'}
                      </div>
                    );
                  })()}
                  {/* 展开列出失败集（最多 10 条） */}
                  {item.episodes.some((e) => e.verify === 'fail') && (
                    <ul className="space-y-0.5 text-danger/80">
                      {item.episodes
                        .filter((e) => e.verify === 'fail')
                        .slice(0, 10)
                        .map((e, j) => (
                          <li key={j}>
                            {e.name}：{e.verifyError || '不可播放'}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: StrmTask['items'][number]['status'] }) {
  return (
    <span
      className={cn(
        'w-2 h-2 rounded-full shrink-0',
        status === 'done' && 'bg-success',
        status === 'failed' && 'bg-danger',
        status === 'running' && 'bg-info animate-pulse',
        status === 'pending' && 'bg-line'
      )}
      aria-label={status}
    />
  );
}
