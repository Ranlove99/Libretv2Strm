'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from '@/components/toast';
import { Spinner, EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';
import { StrmRepairProgress } from '@/components/strm-repair-progress';
import { cn, formatNextRun, formatRelativeTime } from '@/lib/utils';

/** 文件面板：浏览输出目录，统计 strm 数量与体积；检查并修复已生成的 strm */

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 检查与修复区块：结构修复默认开，深度修复与验证需显式勾选（都会联网）。
 * 任务在服务端以作业形式执行：关掉页面、切到别的标签都不会中断，
 * 回来时读同一份作业，进度接着走。
 */
function RepairSection({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [opts, setOpts] = useState({ repair: true, deep: false, verify: false });

  // 作业状态：运行中每 1.2 秒刷新一次，跑完自动停下
  const jobsQuery = useQuery({
    queryKey: ['strm-jobs'],
    queryFn: ({ signal }) => api.strmJobs(signal as unknown as AbortSignal),
    refetchInterval: (query) => (query.state.data?.active ? 1200 : false),
  });
  const active = jobsQuery.data?.active ?? null;
  const latest = jobsQuery.data?.jobs?.[0] ?? null;
  const shown = active ?? latest;

  // 定时任务状态（与设置面板共用同一份缓存）：让用户在这里就知道「多久自动跑一次」
  const autoQuery = useQuery({
    queryKey: ['strm-auto'],
    queryFn: ({ signal }) => api.strmAuto(signal as unknown as AbortSignal),
    staleTime: 60 * 1000,
    refetchInterval: (query) => (query.state.data?.activeJob ? 3000 : false),
  });
  const auto = autoQuery.data;

  // 作业完成时刷新一次文件列表（只对同一个作业触发一次）
  const doneRef = useRef('');
  useEffect(() => {
    if (latest && latest.status === 'done' && doneRef.current !== latest.id) {
      doneRef.current = latest.id;
      onDone();
    }
  }, [latest, onDone]);

  const start = async () => {
    setStarting(true);
    try {
      const r = await api.createStrmJob(opts);
      toast(
        r.reused ? '已有检查在进行，直接看下面的进度' : '已开始检查，关掉页面也会继续',
        'success'
      );
      await jobsQuery.refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : '启动失败', 'error');
    } finally {
      setStarting(false);
    }
  };

  const toggle = (key: keyof typeof opts) => setOpts((p) => ({ ...p, [key]: !p[key] }));

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Icon name="check" className="w-4 h-4 text-accent" />
        <span className="text-sm font-medium">检查与修复 STRM</span>
        <button className="ml-auto text-xs text-faint hover:text-content" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '说明'}
        </button>
      </div>

      {open && (
        <ul className="text-xs text-faint leading-relaxed space-y-1 pl-6 list-disc">
          <li>结构修复（不联网）：去掉多余空白/BOM、把 FN Connect 中继域名改回可用地址、旧局域网 IP 改回当前地址、重算失效签名。</li>
          <li>深度修复（联网，慢）：地址验证失败时，按生成任务记录回源重取最新播放地址，可救源站换线路导致的失效。</li>
          <li>修复后验证（联网，慢）：逐文件实拉播放地址，确认真的能播。</li>
          <li>任务在服务端后台执行：关掉页面、切换标签都不会中断；重新进入时接着显示进度，暂停后可从断点继续。</li>
        </ul>
      )}

      {auto && (
        <p className="text-xs text-faint leading-relaxed">
          {auto.activeJob ? (
            <span className="text-accent">定时检查正在后台执行，进度见下方。</span>
          ) : auto.enabled ? (
            <>
              已开启
              {auto.mode === 'daily'
                ? `${auto.everyDays > 1 ? `每 ${auto.everyDays} 天 ` : '每天 '}${auto.at}`
                : `每 ${auto.everyHours} 小时`}
              自动检查{auto.fix ? '并自动回源修复' : ''}，下次
              {auto.nextAt ? formatNextRun(auto.nextAt) : '—'}。
            </>
          ) : (
            '未开启定时检查，可在「设置 → 自动检查与修复」中开启。'
          )}
          {auto.lastRunAt && !auto.activeJob ? (
            <span>
              {' '}
              上次 {formatRelativeTime(auto.lastRunAt)}
              {auto.lastResult ? `：${auto.lastResult}` : ''}
            </span>
          ) : null}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={opts.repair} onChange={() => toggle('repair')} className="accent-accent" />
          结构修复
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={opts.deep} onChange={() => toggle('deep')} className="accent-accent" />
          深度修复（回源重取）
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={opts.verify} onChange={() => toggle('verify')} className="accent-accent" />
          修复后验证
        </label>
        <button
          className="ml-auto btn-sm btn-primary"
          disabled={starting || !!active}
          onClick={() => void start()}
        >
          {starting || active ? <Spinner size="sm" /> : <Icon name="bolt" />}
          {active ? '检查中…' : starting ? '启动中…' : opts.repair ? '检查并修复' : '仅检查'}
        </button>
      </div>

      <StrmRepairProgress job={shown} onChanged={() => void jobsQuery.refetch()} />
    </div>
  );
}

export function StrmFilesPanel() {
  const { toast } = useToast();
  const [dir, setDir] = useState('');

  const filesQuery = useQuery({
    queryKey: ['strm-files', dir],
    queryFn: ({ signal }) => api.strmFiles(dir, signal as unknown as AbortSignal),
  });

  const data = filesQuery.data;
  const entries = data?.entries ?? [];
  const segments = dir ? dir.split('/') : [];

  const enter = useCallback((name: string) => {
    setDir((prev) => (prev ? `${prev}/${name}` : name));
  }, []);

  const goRoot = () => setDir('');

  const goTo = (index: number) => {
    setDir(segments.slice(0, index + 1).join('/'));
  };

  if (filesQuery.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }
  if (filesQuery.error) {
    return <EmptyState title="目录读取失败" description={filesQuery.error.message} />;
  }

  return (
    <div className="space-y-4">
      <RepairSection onDone={() => void filesQuery.refetch()} />

      {/* 统计 + 根路径 */}
      <div className="card p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span>
          STRM 文件：<b className="text-accent">{data?.stats.strmCount ?? 0}</b>
        </span>
        <span>
          总体积：<b>{formatBytes(data?.stats.totalSize ?? 0)}</b>
        </span>
        <button
          className="ml-auto btn-sm btn-secondary"
          onClick={() => void filesQuery.refetch()}
        >
          <Icon name="refresh" />
          刷新
        </button>
      </div>

      {!data?.exists ? (
        <EmptyState
          title="输出目录还不存在"
          description={`生成任务完成后将自动创建：${data?.root ?? ''}`}
        />
      ) : (
        <div className="card">
          {/* 面包屑 */}
          <div className="flex items-center gap-1 p-3 border-b border-line text-sm flex-wrap">
            <button
              onClick={goRoot}
              className={cn(
                'hover:text-content',
                dir ? 'text-accent' : 'text-content'
              )}
            >
              根目录
            </button>
            {segments.map((seg, i) => (
              <span key={`${seg}-${i}`} className="flex items-center gap-1">
                <span className="text-faint">/</span>
                <button
                  onClick={() => goTo(i)}
                  className={cn(
                    'hover:text-content',
                    i === segments.length - 1 ? 'text-content' : 'text-accent'
                  )}
                >
                  {seg}
                </button>
              </span>
            ))}
            <button
              className="ml-auto text-xs text-faint hover:text-content"
              onClick={() => {
                void copyToClipboard(dir ? `${data.root}/${dir}` : data.root).then((ok) => {
                  if (ok) toast('路径已复制', 'success');
                });
              }}
            >
              复制当前路径
            </button>
          </div>

          {entries.length === 0 ? (
            <EmptyState variant="plain" title="空目录" />
          ) : (
            <ul className="divide-y divide-line">
              {entries.map((e) => (
                <li key={e.path}>
                  {e.isDir ? (
                    <button
                      className="w-full flex items-center gap-2 p-3 text-left hover:bg-hover transition-colors"
                      onClick={() => enter(e.name)}
                    >
                      <Icon name="arrowDown" className="w-4 h-4 text-faint rotate-[-90deg]" />
                      <span className="text-sm truncate flex-1">{e.name}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 p-3">
                      <span
                        className={cn(
                          'w-4 text-center text-[10px] font-bold',
                          e.name.endsWith('.strm') ? 'text-accent' : 'text-faint'
                        )}
                      >
                        {e.name.endsWith('.strm') ? 'S' : '·'}
                      </span>
                      <span className="text-sm truncate flex-1">{e.name}</span>
                      <span className="text-xs text-faint shrink-0">
                        {formatBytes(e.size)}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-xs text-faint leading-relaxed">
        提示：在 fnOS 自带的影视应用或 Emby / Jellyfin / Infuse 中，
        把上面这个目录添加为「电影 / 电视剧」媒体库即可播放；
        Infuse 与 Kodi 也可直接播放 .strm 指向的流地址。
      </p>
    </div>
  );
}
