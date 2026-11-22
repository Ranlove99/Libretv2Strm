'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/header';
import { StrmGeneratePanel } from '@/components/strm-generate-panel';
import { StrmTasksPanel } from '@/components/strm-tasks-panel';
import { StrmFilesPanel } from '@/components/strm-files-panel';
import { StrmSettingsPanel } from '@/components/strm-settings-panel';
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
