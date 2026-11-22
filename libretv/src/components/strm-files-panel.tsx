'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from '@/components/toast';
import { Spinner, EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import type { StrmIssueCode, StrmRepairResult } from '@/lib/strm/types';

/** 文件面板：浏览输出目录，统计 strm 数量与体积；检查并修复已生成的 strm */

const ISSUE_LABELS: Record<StrmIssueCode, string> = {
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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 检查与修复区块：结构修复默认开，深度修复与验证需显式勾选（都会联网） */
function RepairSection({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<StrmRepairResult | null>(null);
  const [opts, setOpts] = useState({ repair: true, deep: false, verify: false });

  const run = async () => {
    setRunning(true);
    try {
      const r = await api.repairStrmFiles(opts);
      setResult(r);
      const changed = r.fixed + r.deepFixed;
      const bad = r.unfixable + r.verifyFailed;
      toast(
        `检查 ${r.scanned} 个：修复 ${changed} 个，待处理 ${bad} 个`,
        bad > 0 ? 'error' : 'success'
      );
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : '检查失败', 'error');
    } finally {
      setRunning(false);
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
        </ul>
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
        <button className="ml-auto btn-sm btn-primary" disabled={running} onClick={() => void run()}>
          {running ? <Spinner size="sm" /> : <Icon name="bolt" />}
          {running ? '检查中…' : opts.repair ? '检查并修复' : '仅检查'}
        </button>
      </div>

      {result && (
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>扫描 <b className="text-content">{result.scanned}</b></span>
            <span>正常 <b className="text-content">{result.ok}</b></span>
            <span>结构修复 <b className="text-accent">{result.fixed}</b></span>
            <span>深度修复 <b className="text-accent">{result.deepFixed}</b></span>
            <span>待处理 <b className={result.unfixable ? 'text-danger' : 'text-content'}>{result.unfixable}</b></span>
            {result.pendingRepair > 0 && <span>可修未改 <b className="text-content">{result.pendingRepair}</b></span>}
            {opts.verify && <span>验证失败 <b className={result.verifyFailed ? 'text-danger' : 'text-content'}>{result.verifyFailed}</b></span>}
            {result.truncated && <span className="text-danger">已达扫描上限，部分文件未处理</span>}
          </div>

          {result.details.length > 0 && (
            <ul className="max-h-64 overflow-auto divide-y divide-line rounded-md border border-line">
              {result.details.map((d) => (
                <li key={d.file} className="px-3 py-2 text-xs space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className={cn('shrink-0', d.deepFixed || d.fixed ? 'text-success' : 'text-danger')}>
                      {d.deepFixed ? '已深度修复' : d.fixed ? '已修复' : '未修复'}
                    </span>
                    <span className="truncate text-content" title={d.file}>{d.file}</span>
                  </div>
                  <div className="text-faint">
                    {d.issues.map((c) => ISSUE_LABELS[c]).join('、')}
                    {d.reason ? ` — ${d.reason}` : ''}
                    {d.verify === 'fail' && d.verifyError ? ` — 验证：${d.verifyError}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
