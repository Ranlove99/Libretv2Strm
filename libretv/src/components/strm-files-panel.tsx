'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from '@/components/toast';
import { Spinner, EmptyState } from '@/components/states';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';

/** 文件面板：浏览输出目录，统计 strm 数量与体积 */

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
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
