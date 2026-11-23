'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { useToast } from '@/components/toast';
import { Spinner } from '@/components/states';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import type { StrmFolderRefreshResult } from '@/lib/strm/types';

/**
 * 文件夹级「手动更新」对话框：选一个采集源，就地重新抓取这部剧并覆盖 strm。
 *
 * 场景：某部剧的 strm 大面积失效，但其它源还有——不必整库重生成，
 * 在这个文件夹上点一下、换个源就修好。默认选中评分最高的源（来自源评分榜）。
 */

/** 与后端 parseFolderTitle 保持一致的轻量版：仅用于界面上显示将要搜索的片名 */
function previewTitle(dir: string): string {
  const segments = dir.split('/').map((s) => s.trim()).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (/^(season\s*\d+|第\s*[0-9一二三四五六七八九十]+\s*季)$/i.test(seg)) continue;
    const m = seg.match(/^(.*?)\s*[（(]\s*(\d{4})?\s*[）)]$/);
    if (m && m[1].trim()) return m[2] ? `${m[1].trim()}（${m[2]}）` : m[1].trim();
    return seg;
  }
  return dir;
}

const keyOf = (url: string) => url.replace(/\/+$/, '');

export function StrmFolderUpdateDialog({
  dir,
  onClose,
  onDone,
}: {
  /** 要更新的文件夹（相对输出目录）；null 表示关闭 */
  dir: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const sources = useMemo(() => [...customAPIs, ...envSources], [customAPIs, envSources]);

  const scoresQuery = useQuery({
    queryKey: ['strm-sources'],
    queryFn: ({ signal }) => api.strmSources(signal as unknown as AbortSignal),
    staleTime: 30 * 1000,
    enabled: !!dir,
  });

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StrmFolderRefreshResult | null>(null);
  const openedFor = useRef<string | null>(null);

  // 每次打开新文件夹：清空状态，默认选评分最高的源
  useEffect(() => {
    if (!dir) {
      openedFor.current = null;
      return;
    }
    if (openedFor.current === dir) return;
    openedFor.current = dir;
    setError('');
    setResult(null);
    setBusy(false);
    setUrl('');
  }, [dir]);

  // 源列表 / 评分到位后补默认值（评分高的排前面）
  useEffect(() => {
    if (!dir || url) return;
    const scoreOf = new Map((scoresQuery.data?.sources ?? []).map((s) => [keyOf(s.url), s.score]));
    const ranked = [...sources].sort(
      (a, b) => (scoreOf.get(keyOf(b.url)) ?? 50) - (scoreOf.get(keyOf(a.url)) ?? 50)
    );
    if (ranked[0]) setUrl(ranked[0].url);
  }, [dir, url, sources, scoresQuery.data]);

  useEffect(() => {
    if (!dir) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dir, busy, onClose]);

  if (!dir) return null;

  const submit = async () => {
    if (!url) return;
    const src = sources.find((s) => s.url === url);
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const r = await api.refreshStrmFolder({
        dir,
        sourceUrl: url,
        sourceName: src?.name,
        sourceKey: src?.key,
      });
      setResult(r);
      if (r.ok) {
        toast(
          `已更新 ${r.written ?? 0} 个文件${r.removed ? `，清理 ${r.removed} 个旧文件` : ''}`,
          'success'
        );
        onDone();
      } else {
        setError(r.error || '更新失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败');
    } finally {
      setBusy(false);
    }
  };

  const target = previewTitle(dir);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 animate-fade-in" onClick={() => !busy && onClose()} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="手动更新"
        className="relative bg-surface-raised rounded-xl w-full max-w-md shadow-2xl p-5 animate-slide-up space-y-4"
      >
        <div className="flex items-start gap-2">
          <Icon name="refresh" className="w-4 h-4 text-accent mt-0.5" />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-content">手动更新</h2>
            <p className="text-xs text-faint mt-0.5 break-all">{dir}</p>
          </div>
          <button
            className="text-faint hover:text-content shrink-0"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <p className="text-xs text-muted leading-relaxed">
          用所选源按片名「<b className="text-content">{target}</b>」重新搜索，
          覆盖该文件夹里的 .strm；新源集数变少时会清理多余的旧文件。
        </p>

        <label className="block space-y-1">
          <span className="text-sm">选择采集源</span>
          <select
            className="input w-full text-sm"
            value={url}
            disabled={busy || sources.length === 0}
            onChange={(e) => setUrl(e.target.value)}
          >
            {sources.length === 0 && <option value="">没有可用的源</option>}
            {sources.map((s) => {
              const score = scoresQuery.data?.sources.find((x) => keyOf(x.url) === keyOf(s.url))?.score;
              return (
                <option key={s.key} value={s.url}>
                  {s.name}
                  {score !== undefined ? ` · ${score} 分` : ''}
                </option>
              );
            })}
          </select>
          <span className="block text-xs text-faint">
            分数来自源评分榜（成功率 + 响应速度），默认选中最高分的源
          </span>
        </label>

        {error && (
          <div className="text-xs text-danger border border-danger/40 rounded-md p-2 space-y-1">
            <div>{error}</div>
            {result?.candidates && result.candidates.length > 0 && (
              <div className="text-faint">
                该源搜到相近标题：{result.candidates.join('、')}
              </div>
            )}
          </div>
        )}

        {result?.ok && (
          <div className="text-xs text-success border border-success/40 rounded-md p-2 space-y-1">
            <div>
              已匹配「{result.matched?.title}
              {result.matched?.year ? ` (${result.matched.year})` : ''}」
              {result.matched?.kind === 'tv' ? `，共 ${result.matched.episodes} 集` : ''}
              ，写入 {result.written} 个文件
              {result.removed ? `，清理 ${result.removed} 个旧文件` : ''}
            </div>
            {result.targetDir && result.targetDir !== dir && (
              <div className="text-warning">
                源站标题与文件夹不一致，文件写到了：{result.targetDir}（旧目录未删除，请自行确认）
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button className="btn-ghost text-sm" disabled={busy} onClick={onClose}>
            关闭
          </button>
          <button
            className={cn('btn-primary text-sm')}
            disabled={busy || !url || sources.length === 0}
            onClick={() => void submit()}
          >
            {busy ? <Spinner size="sm" /> : null}
            {busy ? '更新中…' : '开始更新'}
          </button>
        </div>
      </div>
    </div>
  );
}
