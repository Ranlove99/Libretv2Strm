'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { useToast } from '@/components/toast';
import { Spinner, EmptyState, ErrorState } from '@/components/states';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import type { SourceConfig } from '@/lib/types';
import type { CatalogVideo } from '@/lib/strm/types';

/** 生成面板：选源 → 搜索/浏览 → 多选 → 创建生成任务 */

interface PickItem {
  sourceKey: string;
  sourceName: string;
  sourceUrl: string;
  vodId: string;
  title: string;
  year?: string;
  typeName?: string;
}

interface Props {
  prefill: { sourceKey: string; vodId: string; title: string } | null;
  onGoTasks: () => void;
}

type Mode = 'search' | 'browse';

export function StrmGeneratePanel({ prefill, onGoTasks }: Props) {
  const { toast } = useToast();
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const yellowFilter = useAppStore((s) => s.yellowFilter);

  const allSources = useMemo<SourceConfig[]>(
    () => [...customAPIs, ...envSources],
    [customAPIs, envSources]
  );

  const [sourceKey, setSourceKey] = useState<string>(prefill?.sourceKey ?? '');
  const [mode, setMode] = useState<Mode>('search');
  const [wd, setWd] = useState('');
  const [videos, setVideos] = useState<CatalogVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // 已选影片：key = sourceUrl|vodId（与服务端去重键一致）
  const [selected, setSelected] = useState<Map<string, PickItem>>(new Map());
  const [submitting, setSubmitting] = useState(false);

  // 浏览模式状态
  const [classes, setClasses] = useState<{ id: string; name: string }[]>([]);
  const [classId, setClassId] = useState('');
  const [page, setPage] = useState(1);
  const [pagecount, setPagecount] = useState(1);
  const [browseUnsupported, setBrowseUnsupported] = useState(false);

  const source = useMemo(
    () => allSources.find((s) => s.key === sourceKey) ?? null,
    [allSources, sourceKey]
  );

  const selKey = (v: CatalogVideo, src: SourceConfig) => `${src.url.replace(/\/+$/, '')}|${v.vodId}`;

  // 预选影片回填（详情页跳转而来）
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current || !prefill) return;
    prefilledRef.current = true;
    const src = allSources.find((s) => s.key === prefill.sourceKey);
    if (!src) {
      toast('预选的视频源不在当前源列表中，请手动选择', 'warning');
      return;
    }
    setSourceKey(src.key);
    setSelected((prev) => {
      const next = new Map(prev);
      next.set(`${src.url.replace(/\/+$/, '')}|${prefill.vodId}`, {
        sourceKey: src.key,
        sourceName: src.name,
        sourceUrl: src.url,
        vodId: prefill.vodId,
        title: prefill.title || prefill.vodId,
      });
      return next;
    });
  }, [prefill, allSources, toast]);

  // —— 搜索 ——
  const runSearch = useCallback(async () => {
    if (!source) return;
    const q = wd.trim();
    if (!q) {
      toast('请输入搜索关键词', 'warning');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.search(q, [source], yellowFilter);
      setVideos(res.list.map((item) => ({
        vodId: item.vodId,
        name: item.name,
        pic: item.pic,
        typeName: item.typeName,
        year: item.year,
        area: item.area,
        remarks: item.remarks,
      })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '搜索失败');
      setVideos([]);
    } finally {
      setLoading(false);
    }
  }, [source, wd, yellowFilter, toast]);

  // —— 浏览：分类树 + 分页列表 ——
  const homeQuery = useQuery({
    queryKey: ['strm-catalog-home', sourceKey],
    queryFn: ({ signal }) => api.strmCatalogHome(source as SourceConfig, signal),
    enabled: mode === 'browse' && !!source,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (homeQuery.data) {
      setClasses(homeQuery.data.classes);
      setBrowseUnsupported(homeQuery.data.classes.length === 0);
      // 未选分类时展示最新列表
      if (!classId && homeQuery.data.videos.length > 0) {
        setVideos(homeQuery.data.videos);
      }
    }
  }, [homeQuery.data, classId]);

  const loadClassPage = useCallback(
    async (tid: string, pg: number) => {
      if (!source) return;
      setLoading(true);
      setError('');
      try {
        const res = await api.strmCatalogList(source, tid, pg);
        setVideos(res.videos);
        setPage(res.page || pg);
        setPagecount(res.pagecount || 1);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '分类加载失败');
        setVideos([]);
      } finally {
        setLoading(false);
      }
    },
    [source]
  );

  const toggleItem = (v: CatalogVideo) => {
    if (!source) return;
    const key = selKey(v, source);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, {
          sourceKey: source.key,
          sourceName: source.name,
          sourceUrl: source.url,
          vodId: v.vodId,
          title: v.name,
          year: v.year,
          typeName: v.typeName,
        });
      }
      return next;
    });
  };

  const quickGenerate = (v: CatalogVideo) => {
    if (!source) return;
    setSubmitting(true);
    api
      .createStrmTask({
        title: `${v.name}`,
        items: [
          {
            sourceKey: source.key,
            sourceName: source.name,
            sourceUrl: source.url,
            vodId: v.vodId,
            title: v.name,
            year: v.year,
            typeName: v.typeName,
          },
        ],
      })
      .then(() => {
        toast(`已创建任务：${v.name}`, 'success');
        onGoTasks();
      })
      .catch((err: unknown) => {
        toast(err instanceof Error ? err.message : '创建任务失败', 'error');
      })
      .finally(() => setSubmitting(false));
  };

  const startBatch = async () => {
    if (!source || selected.size === 0) return;
    setSubmitting(true);
    try {
      await api.createStrmTask({
        title: `批量生成（${selected.size} 部）`,
        items: [...selected.values()],
      });
      setSelected(new Map());
      toast(`已创建任务（${selected.size} 部），切换到任务页查看进度`, 'success');
      onGoTasks();
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建任务失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (allSources.length === 0) {
    return (
      <EmptyState
        title="尚未配置点播源"
        description="请先在右上角「设置」中添加采集站源，再回来生成媒体库"
      />
    );
  }

  return (
    <div className="grid lg:grid-cols-[1fr_300px] gap-6 items-start">
      {/* 左：选源 + 搜索/浏览 + 结果 */}
      <div className="space-y-4">
        <div className="card p-4 flex flex-wrap items-center gap-3">
          <label className="text-sm text-muted">点播源</label>
          <select
            className="input flex-1 min-w-[200px]"
            value={sourceKey}
            onChange={(e) => {
              setSourceKey(e.target.value);
              setVideos([]);
              setClasses([]);
              setClassId('');
              setError('');
            }}
          >
            <option value="">选择源…</option>
            {allSources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="flex rounded-md border border-line overflow-hidden">
            {(['search', 'browse'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setVideos([]);
                  setError('');
                }}
                className={cn(
                  'px-3 py-1.5 text-xs transition-colors',
                  mode === m ? 'bg-accent text-on-accent' : 'text-muted hover:text-content'
                )}
              >
                {m === 'search' ? '搜索' : '分类浏览'}
              </button>
            ))}
          </div>
        </div>

        {!source ? (
          <EmptyState title="请选择一个点播源" description="不同源的资源库互不相同" />
        ) : mode === 'search' ? (
          <div className="card p-4 flex gap-2">
            <input
              className="input flex-1"
              placeholder="搜索影片名称，如：斗罗大陆"
              value={wd}
              maxLength={100}
              onChange={(e) => setWd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch();
              }}
            />
            <button className="btn-primary" onClick={() => void runSearch()} disabled={loading}>
              {loading ? <Spinner size="sm" /> : '搜索'}
            </button>
          </div>
        ) : (
          <div className="card p-4 space-y-3">
            {homeQuery.isLoading ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : homeQuery.error ? (
              <ErrorState
                message={homeQuery.error instanceof Error ? homeQuery.error.message : '加载失败'}
                onRetry={() => void homeQuery.refetch()}
              />
            ) : browseUnsupported ? (
              <div className="text-sm text-muted">
                该源不支持目录浏览（未返回分类信息），请改用「搜索」模式选片
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      setClassId('');
                      setVideos(homeQuery.data?.videos ?? []);
                    }}
                    className={cn(
                      'chip',
                      !classId && 'bg-accent text-on-accent'
                    )}
                  >
                    最新
                  </button>
                  {classes.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setClassId(c.id);
                        setPage(1);
                        void loadClassPage(c.id, 1);
                      }}
                      className={cn('chip', classId === c.id && 'bg-accent text-on-accent')}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
                {classId && pagecount > 1 && (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <button
                      className="btn-sm btn-secondary"
                      disabled={page <= 1 || loading}
                      onClick={() => void loadClassPage(classId, page - 1)}
                    >
                      上一页
                    </button>
                    <span>
                      {page} / {pagecount}
                    </span>
                    <button
                      className="btn-sm btn-secondary"
                      disabled={page >= pagecount || loading}
                      onClick={() => void loadClassPage(classId, page + 1)}
                    >
                      下一页
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {error && <ErrorState message={error} />}

        {loading && videos.length === 0 ? (
          <div className="flex justify-center py-10">
            <Spinner size="lg" />
          </div>
        ) : videos.length > 0 ? (
          <div className="card divide-y divide-line">
            {videos.map((v) => {
              const key = selKey(v, source!);
              const checked = selected.has(key);
              return (
                <div key={key} className="flex items-center gap-3 p-3 hover:bg-hover transition-colors">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleItem(v)}
                    aria-label={`选择 ${v.name}`}
                    className="w-4 h-4 accent-[rgb(var(--c-accent))]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{v.name}</div>
                    <div className="text-xs text-faint truncate">
                      {[v.typeName, v.year, v.area, v.remarks].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <button
                    className="btn-sm btn-secondary shrink-0"
                    disabled={submitting}
                    onClick={() => quickGenerate(v)}
                  >
                    <Icon name="download" />
                    直接生成
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* 右：已选 + 开始生成 */}
      <div className="card p-4 space-y-3 lg:sticky lg:top-20">
        <div className="text-sm font-medium">
          已选影片 <span className="text-accent">{selected.size}</span>
        </div>
        {selected.size === 0 ? (
          <div className="text-xs text-faint leading-relaxed">
            勾选左侧搜索结果（或点「直接生成」单部处理），
            批量勾选后在这里一次性创建任务。
          </div>
        ) : (
          <ul className="max-h-72 overflow-auto space-y-1 text-xs">
            {[...selected.values()].map((it) => (
              <li key={`${it.sourceUrl}|${it.vodId}`} className="flex items-center gap-1 group">
                <span className="truncate flex-1">{it.title}</span>
                <button
                  className="text-faint hover:text-danger shrink-0"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Map(prev);
                      next.delete(`${it.sourceUrl.replace(/\/+$/, '')}|${it.vodId}`);
                      return next;
                    })
                  }
                  aria-label={`移除 ${it.title}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          className="btn-primary w-full"
          disabled={selected.size === 0 || submitting}
          onClick={() => void startBatch()}
        >
          {submitting ? <Spinner size="sm" /> : `开始生成（${selected.size}）`}
        </button>
        <div className="text-[11px] text-faint leading-relaxed">
          任务在服务端异步执行：拉取每集播放地址 → 按命名模板写 .strm → 生成 NFO 与海报。
          NAS 重启不丢失任务记录。
        </div>
      </div>
    </div>
  );
}
