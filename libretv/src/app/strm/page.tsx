'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/header';
import { StrmGeneratePanel } from '@/components/strm-generate-panel';
import { StrmTasksPanel } from '@/components/strm-tasks-panel';
import { StrmFilesPanel } from '@/components/strm-files-panel';
import { StrmSettingsPanel } from '@/components/strm-settings-panel';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

type TabKey = 'generate' | 'tasks' | 'files' | 'settings';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'generate', label: '生成媒体库' },
  { key: 'tasks', label: '生成任务' },
  { key: 'files', label: '媒体库文件' },
  { key: 'settings', label: '设置' },
];

export default function StrmPage() {
  return (
    <Suspense>
      <StrmContent />
    </Suspense>
  );
}

function StrmContent() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<TabKey>('generate');

  // 把浏览器里的源列表（订阅 / 自定义 / 环境源）上报到服务端注册表：
  // 跨源替代修复的候选池来自这里，定时任务没有浏览器参与也依赖它
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const syncedSourcesRef = useRef('');
  useEffect(() => {
    const payload = [...customAPIs, ...envSources]
      .map((s) => ({ key: s.key, name: s.name, url: s.url }))
      .sort((a, b) => a.url.localeCompare(b.url));
    const sig = JSON.stringify(payload);
    if (!sig || sig === syncedSourcesRef.current) return;
    syncedSourcesRef.current = sig;
    api.syncStrmSources(payload).catch(() => {
      // 上报失败静默：下次进入页面会重试；服务端还有任务记录兜底
      syncedSourcesRef.current = '';
    });
  }, [customAPIs, envSources]);

  // 从详情页跳转带入的预选影片（?source=&id=&title=）
  const prefill =
    searchParams.get('source') && searchParams.get('id')
      ? {
          sourceKey: searchParams.get('source') as string,
          vodId: searchParams.get('id') as string,
          title: searchParams.get('title') || '',
        }
      : null;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        <div className="flex items-center gap-1 mb-6 border-b border-line overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
                tab === t.key
                  ? 'border-accent text-content'
                  : 'border-transparent text-muted hover:text-content'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'generate' && <StrmGeneratePanel prefill={prefill} onGoTasks={() => setTab('tasks')} />}
        {tab === 'tasks' && <StrmTasksPanel />}
        {tab === 'files' && <StrmFilesPanel />}
        {tab === 'settings' && <StrmSettingsPanel />}
      </main>
    </div>
  );
}
