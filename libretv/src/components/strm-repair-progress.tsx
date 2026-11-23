'use client';

import { useState } from 'react';
import { api } from '@/lib/client-api';
import { useToast } from '@/components/toast';
import { Spinner } from '@/components/states';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import type { StrmIssueCode, StrmJobView } from '@/lib/strm/types';

/** 检查 / 修复作业的进度与结果展示：文件面板与设置页共用 */

export const ISSUE_LABELS: Record<StrmIssueCode, string> = {
  empty: '文件为空',
  'not-url': '不是播放地址',
  whitespace: '多余空白/BOM',
  'proxy-missing-sig': '缺签名',
  'proxy-bad-sig': '签名失效（改过密码）',
  'proxy-relay-base': '中继域名不可播',
  'proxy-stale-lan-base': '旧局域网 IP',
  'proxy-bad-target': '缺上游地址',
  'direct-relay-host': '直链指向中继',
  unreadable: '文件读取失败',
};

const STATUS_TEXT: Record<StrmJobView['status'], string> = {
  running: '检查中',
  paused: '已暂停',
  done: '已完成',
  canceled: '已取消',
  failed: '失败',
};

function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest > 0 ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
}

export function StrmRepairProgress({
  job,
  onChanged,
}: {
  job: StrmJobView | null;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  if (!job) return null;

  const pct = job.total > 0 ? Math.min(100, Math.floor((job.done / job.total) * 100)) : 0;
  const running = job.status === 'running';
  const paused = job.status === 'paused';
  const live = running || paused;

  const control = async (action: 'pause' | 'resume' | 'cancel') => {
    setBusy(true);
    try {
      await api.controlStrmJob(job.id, action);
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5">
          {running && <Spinner size="sm" />}
          <b className={cn(running ? 'text-accent' : paused ? 'text-warning' : 'text-content')}>
            {STATUS_TEXT[job.status]}
          </b>
        </span>
        <span className="text-faint">
          {job.done} / {job.total}
          {job.total > 0 ? `（${pct}%）` : ''}
        </span>
        {job.startedAt && (
          <span className="text-faint">
            已用 {formatDuration((job.finishedAt ?? Date.now()) - job.startedAt)}
          </span>
        )}
        <span className="text-faint">
          正常 <b className="text-content">{job.ok}</b>
        </span>
        {job.fixed > 0 && (
          <span className="text-faint">
            结构修复 <b className="text-accent">{job.fixed}</b>
          </span>
        )}
        {job.deepFixed > 0 && (
          <span className="text-faint">
            回源修复 <b className="text-accent">{job.deepFixed}</b>
          </span>
        )}
        {job.pendingRepair > 0 && (
          <span className="text-faint">
            可修未改 <b className="text-content">{job.pendingRepair}</b>
          </span>
        )}
        {job.fail > 0 && (
          <span className="text-faint">
            仍失效 <b className="text-danger">{job.fail}</b>
          </span>
        )}
        {job.verifyFailed > 0 && (
          <span className="text-faint">
            验证失败 <b className="text-danger">{job.verifyFailed}</b>
          </span>
        )}
        {job.trigger === 'auto' && <span className="text-faint">定时任务</span>}
        {live && (
          <span className="ml-auto flex items-center gap-1">
            <button
              className="btn-ghost text-xs"
              disabled={busy}
              onClick={() => void control(running ? 'pause' : 'resume')}
            >
              {running ? '暂停' : '继续'}
            </button>
            <button className="btn-ghost text-xs" disabled={busy} onClick={() => void control('cancel')}>
              取消
            </button>
          </span>
        )}
      </div>

      <div className="h-1.5 rounded-full bg-line overflow-hidden">
        <div
          className={cn('h-full transition-all duration-500', running ? 'bg-accent' : 'bg-accent/60')}
          style={{ width: `${pct}%` }}
        />
      </div>

      {running && job.current && (
        <p className="text-xs text-faint truncate" title={job.current}>
          正在处理：{job.current}
        </p>
      )}
      {job.note && !running && <p className="text-xs text-faint">{job.note}</p>}
      {paused && job.remaining > 0 && (
        <p className="text-xs text-warning">
          还有 {job.remaining} 个文件未处理，点「继续」接着跑（已完成的不再重复探测）
        </p>
      )}

      {job.problemsTotal > 0 && (
        <ul className="max-h-64 overflow-auto divide-y divide-line rounded-md border border-line">
          {job.problems.map((d) => (
            <li key={d.file} className="px-3 py-2 text-xs space-y-0.5">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'shrink-0',
                    d.state === 'deep-fixed' || d.state === 'fixed' ? 'text-success' : 'text-danger'
                  )}
                >
                  {d.state === 'deep-fixed' ? '已回源修复' : d.state === 'fixed' ? '已修复' : '未修复'}
                </span>
                <span className="truncate text-content" title={d.file}>
                  {d.file}
                </span>
              </div>
              <div className="text-faint">
                {(d.issues ?? []).map((c) => ISSUE_LABELS[c] ?? c).join('、')}
                {d.reason ? ` — ${d.reason}` : ''}
                {d.verify === 'fail' && d.verifyError ? ` — 验证：${d.verifyError}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
      {job.problemsTotal > job.problems.length && (
        <p className="text-xs text-faint">
          仅显示前 {job.problems.length} 条，共 {job.problemsTotal} 个问题文件
        </p>
      )}
    </div>
  );
}

/** 进度条 + 一行摘要，供设置页等空间紧张的位置使用 */
export function StrmRepairProgressBar({ job }: { job: StrmJobView | null }) {
  if (!job) return null;
  const pct = job.total > 0 ? Math.min(100, Math.floor((job.done / job.total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <Icon name="refresh" className="w-3 h-3 text-accent" />
        <span className="text-content">
          {STATUS_TEXT[job.status]} {job.done}/{job.total}
        </span>
        <span className="text-faint">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-line overflow-hidden">
        <div className="h-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      {job.current && <p className="text-xs text-faint truncate">{job.current}</p>}
    </div>
  );
}
