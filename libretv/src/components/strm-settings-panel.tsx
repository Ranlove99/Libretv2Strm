'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useToast } from '@/components/toast';
import { Spinner } from '@/components/states';
import { StrmRepairProgress } from '@/components/strm-repair-progress';
import { cn, formatNextRun, formatRelativeTime } from '@/lib/utils';
import type { StrmConfig } from '@/lib/strm/types';

/** 设置面板：输出目录 / URL 模式 / 命名模板 / NFO 与海报开关 / 定时检查与修复 */

export function StrmSettingsPanel() {
  const { toast } = useToast();
  const configQuery = useQuery({
    queryKey: ['strm-config'],
    queryFn: () => api.strmConfig(),
    staleTime: 30 * 1000,
  });

  // 定时任务配置摘要（下次执行 / 上次结果）
  const autoQuery = useQuery({
    queryKey: ['strm-auto'],
    queryFn: ({ signal }) => api.strmAuto(signal as unknown as AbortSignal),
    staleTime: 30 * 1000,
  });
  const auto = autoQuery.data;

  // 正在执行的作业：有进度时每 1.5 秒刷新，跑完自动停下
  const jobsQuery = useQuery({
    queryKey: ['strm-jobs'],
    queryFn: ({ signal }) => api.strmJobs(signal as unknown as AbortSignal),
    refetchInterval: (query) => (query.state.data?.active ? 1500 : false),
  });
  const activeJob = jobsQuery.data?.active ?? null;

  // 作业跑完时刷新一次定时摘要（「上次执行」文案来自作业结果）
  const prevActiveId = useRef<string | null>(null);
  useEffect(() => {
    if (prevActiveId.current && !activeJob) void autoQuery.refetch();
    prevActiveId.current = activeJob?.id ?? null;
  }, [activeJob, autoQuery]);

  const [form, setForm] = useState<StrmConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);

  useEffect(() => {
    if (configQuery.data && !form) {
      setForm(configQuery.data.config);
    }
  }, [configQuery.data, form]);

  // 旧版本配置被服务端自动迁移时的说明（一次性）：直接显示在面板顶部，不弹窗打断
  const [migrationNotice, setMigrationNotice] = useState('');
  useEffect(() => {
    const notice = configQuery.data?.notice;
    if (notice) setMigrationNotice(notice);
  }, [configQuery.data?.notice]);

  if (configQuery.isLoading || !form) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  const set = <K extends keyof StrmConfig>(key: K, value: StrmConfig[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const res = await api.saveStrmConfig(form as unknown as Record<string, unknown>);
      await configQuery.refetch();
      // 频率改了，下次执行时间要跟着重算
      void autoQuery.refetch();
      // 服务端纠正了对外地址（如中继域名 → 局域网地址）时，把原因讲清楚
      if (res?.warning) toast(res.warning, 'error');
      else toast('设置已保存', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const data = configQuery.data;

  /** 立即按自动任务的方式跑一次：先落盘当前表单，定时任务读的是服务端配置 */
  const runAutoNow = async () => {
    const current = form;
    if (!current) return;
    setAutoRunning(true);
    try {
      await api.saveStrmConfig(current as unknown as Record<string, unknown>);
      const r = await api.runStrmAuto();
      await Promise.all([autoQuery.refetch(), jobsQuery.refetch()]);
      toast(r.reason, r.started ? 'success' : 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : '执行失败', 'error');
    } finally {
      setAutoRunning(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      {migrationNotice && (
        <div className="card p-3 text-xs text-accent border-accent/40 flex items-start gap-2">
          <span className="flex-1">{migrationNotice}</span>
          <button
            className="shrink-0 text-faint hover:text-content"
            aria-label="关闭提示"
            onClick={() => setMigrationNotice('')}
          >
            ✕
          </button>
        </div>
      )}
      {data && (!data.outputExists || !data.outputWritable) && (
        <div className="card p-3 text-xs text-warning border-warning/40">
          输出目录{data.outputExists ? '不可写' : '不存在'}：{form.outputDir}
          （保存时会自动创建；请确认运行用户有该路径权限）
        </div>
      )}

      <Section title="输出">
        <Field label="输出目录" hint=".strm / .nfo / 海报的写入根目录，须为绝对路径">
          <div className="flex gap-2">
            <input
              className="input w-full font-mono text-xs"
              value={form.outputDir}
              onChange={(e) => set('outputDir', e.target.value)}
            />
            {data?.defaultOutputDir && data.defaultOutputDir !== form.outputDir && (
              <button
                className="btn-ghost shrink-0 text-xs"
                onClick={() => set('outputDir', data.defaultOutputDir as string)}
                title="恢复到安装时预留的默认媒体库目录"
              >
                恢复默认
              </button>
            )}
          </div>
        </Field>
        <div className="text-xs text-faint space-y-1">
          <p>
            默认输出位置为共享目录 <span className="font-mono">libretv-strm</span>
            （文件管理 → 共享文件夹中可见），媒体服务器可直接扫描；可在此改为任意
            NAS 目录，保存后立即生效，已生成的文件不会自动移动。
          </p>
          <p>
            应用数据目录：<span className="font-mono">{data?.dataRoot}</span>
            （任务记录与配置存放于此，升级不丢失）
          </p>
        </div>
      </Section>

      <Section title="STRM 内容">
        <Field label="URL 模式">
          <div className="flex gap-2">
            {([
              {
                v: 'direct' as const,
                label: '采集站直链',
                desc: '默认。媒体服务器直连上游取流，不依赖 NAS 地址与中继',
              },
              {
                v: 'proxy' as const,
                label: '经本站代理',
                desc: '上游有防盗链时用；需媒体服务器能访问下方地址',
              },
            ]).map((opt) => (
              <button
                key={opt.v}
                onClick={() => set('urlMode', opt.v)}
                className={cn(
                  'flex-1 text-left p-3 rounded-md border transition-colors',
                  form.urlMode === opt.v
                    ? 'border-accent bg-accent/5'
                    : 'border-line hover:bg-hover'
                )}
              >
                <div className="text-sm">{opt.label}</div>
                <div className="text-xs text-faint mt-0.5">{opt.desc}</div>
              </button>
            ))}
          </div>
        </Field>
        {form.urlMode === 'direct' && (
          <p className="text-xs text-faint">
            直链模式下 strm 里写的是采集站的原始播放地址，播放时由媒体服务器 / 播放器直接向上游取流：
            不受 NAS 局域网地址、端口映射、飞牛中继是否可用影响，也不占用 NAS 上行带宽。
            若某个源有 Referer 防盗链导致直链 403，再切到「经本站代理」。
          </p>
        )}
        {form.urlMode === 'proxy' && (
          <Field
            label="对外访问地址"
            hint="媒体服务器通过该地址回取视频，填 http://<NAS-IP>:8099；留空则用创建任务时的访问地址"
          >
            <input
              className="input w-full font-mono text-xs"
              placeholder="http://192.168.1.118:8099"
              value={form.publicBaseUrl}
              onChange={(e) => set('publicBaseUrl', e.target.value)}
            />
            {data?.detectedBaseUrls && data.detectedBaseUrls.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-faint">本机局域网地址：</span>
                {data.detectedBaseUrls.map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => set('publicBaseUrl', u)}
                    className={cn(
                      'btn-ghost text-xs font-mono',
                      form.publicBaseUrl === u && 'border-accent text-accent'
                    )}
                  >
                    {u}
                  </button>
                ))}
              </div>
            )}
            {isRelayUrl(form.publicBaseUrl) && (
              <div className="mt-1 text-xs text-warning border border-warning/40 rounded-md p-2">
                这是 fnOS 中继（FN Connect）域名。中继只放行带 fnOS 登录态的浏览器请求，
                媒体服务器 / Emby / 播放器请求会被中继网关拒绝（403），strm 一定播不了；
                保存时会自动替换为局域网地址。跨网播放请用端口映射或反向代理的公网地址。
              </div>
            )}
          </Field>
        )}
      </Section>

      <Section title="命名模板">
        <Field label="电影模板" hint="占位符：{title} {year}">
          <input
            className="input w-full font-mono text-xs"
            value={form.movieTemplate}
            onChange={(e) => set('movieTemplate', e.target.value)}
          />
        </Field>
        <Field label="剧集模板" hint="占位符：{title} {year} {season} {episode}，支持 {season:02d} 补零">
          <input
            className="input w-full font-mono text-xs"
            value={form.tvTemplate}
            onChange={(e) => set('tvTemplate', e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.separateTv}
            onChange={(e) => set('separateTv', e.target.checked)}
            className="w-4 h-4 accent-[rgb(var(--c-accent))]"
          />
          电影 / 剧集分顶层目录存放
        </label>
      </Section>

      <Section title="刮削与任务">
        <Toggle
          label="生成 NFO 文件"
          desc="Emby / Jellyfin 可直接识别影片信息"
          checked={form.generateNfo}
          onChange={(v) => set('generateNfo', v)}
        />
        <Toggle
          label="下载海报"
          desc="保存 poster.jpg 到媒体目录"
          checked={form.downloadPoster}
          onChange={(v) => set('downloadPoster', v)}
        />
        <Toggle
          label="生成后自动测试有效性"
          desc="逐集实际请求播放地址验证能否拉流，结果在任务明细中标记（会增加任务耗时）"
          checked={form.verifyAfterGenerate}
          onChange={(v) => set('verifyAfterGenerate', v)}
        />
        <Field label="任务并发数" hint="同时处理的影片数量，采集站敏感时调小">
          <input
            type="number"
            min={1}
            max={5}
            className="input w-24"
            value={form.concurrency}
            onChange={(e) => set('concurrency', Number.parseInt(e.target.value, 10) || 1)}
          />
        </Field>
        <Field label="单影片集数上限" hint="0 表示不限制；长剧可限制避免超长任务">
          <input
            type="number"
            min={0}
            max={5000}
            className="input w-24"
            value={form.maxEpisodes}
            onChange={(e) => set('maxEpisodes', Number.parseInt(e.target.value, 10) || 0)}
          />
        </Field>
      </Section>

      <Section title="自动检查与修复">
        <Toggle
          label="每天定时检查 .strm 可用性"
          desc="到点由应用自己在后台发起，关掉页面也会继续；逐条实拉地址，建议放在 NAS 常开的凌晨"
          checked={form.autoCheck}
          onChange={(v) => set('autoCheck', v)}
        />
        <Field label="执行频率" hint="本机时间；daily 模式当天错过 6 小时内会自动补跑一次">
          <div className="space-y-2">
            <div className="flex gap-2">
              {([
                { v: 'daily' as const, label: '按天', desc: '可设多天间隔' },
                { v: 'interval' as const, label: '按小时', desc: '固定间隔重复' },
              ]).map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  disabled={!form.autoCheck}
                  onClick={() => set('autoCheckMode', opt.v)}
                  className={cn(
                    'flex-1 text-left p-2.5 rounded-md border transition-colors',
                    form.autoCheckMode === opt.v
                      ? 'border-accent bg-accent/5'
                      : 'border-line hover:bg-hover',
                    !form.autoCheck && 'opacity-50'
                  )}
                >
                  <div className="text-sm">{opt.label}</div>
                  <div className="text-xs text-faint mt-0.5">{opt.desc}</div>
                </button>
              ))}
            </div>

            {form.autoCheckMode === 'daily' ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">每</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  className="input w-16"
                  disabled={!form.autoCheck}
                  value={form.autoCheckEveryDays}
                  onChange={(e) => set('autoCheckEveryDays', Number.parseInt(e.target.value, 10) || 1)}
                />
                <span className="text-muted">天</span>
                <input
                  type="time"
                  className="input w-32"
                  disabled={!form.autoCheck}
                  value={form.autoCheckAt}
                  onChange={(e) => set('autoCheckAt', e.target.value || '03:00')}
                />
                <span className="text-muted">执行</span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">每</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  className="input w-20"
                  disabled={!form.autoCheck}
                  value={form.autoCheckEveryHours}
                  onChange={(e) => set('autoCheckEveryHours', Number.parseInt(e.target.value, 10) || 1)}
                />
                <span className="text-muted">小时执行一次（从上次开始算）</span>
              </div>
            )}
          </div>
        </Field>
        <Toggle
          label="检查出失效后自动回源修复"
          desc="只处理失效文件，可用的不动；按生成任务记录回源重取最新播放地址"
          checked={form.autoFix}
          onChange={(v) => set('autoFix', v)}
        />

        <div className="text-xs text-faint space-y-1">
          <div>
            下次执行：
            <b className="text-content">
              {auto?.enabled && auto.nextAt ? formatNextRun(auto.nextAt) : '未开启'}
            </b>
          </div>
          <div>
            上次执行：
            {auto?.lastRunAt ? formatRelativeTime(auto.lastRunAt) : '从未执行'}
            {auto?.lastResult ? ` · ${auto.lastResult}` : ''}
          </div>
        </div>

        <button
          className="btn-sm btn-secondary"
          disabled={autoRunning || !!activeJob}
          onClick={() => void runAutoNow()}
        >
          {autoRunning || activeJob ? <Spinner size="sm" /> : null}
          {activeJob ? '检查进行中…' : '立即检查一次'}
        </button>

        {activeJob && (
          <StrmRepairProgress
            job={activeJob}
            onChanged={() => {
              void jobsQuery.refetch();
              void autoQuery.refetch();
            }}
          />
        )}

        <p className="text-xs text-faint leading-relaxed">
          与「媒体库文件 → 检查并修复」同一套逻辑：结构修复不联网，验证与回源修复会联网。
          手动检查过一次后，当天的定时任务不再重复执行。
        </p>
      </Section>

      <button className="btn-primary" disabled={saving} onClick={() => void save()}>
        {saving ? <Spinner size="sm" /> : '保存设置'}
      </button>
    </div>
  );
}

/** fnOS 中继域名：只能浏览器登录后访问，媒体服务器不可用 */
function isRelayUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return ['fnos.net', '5ddd.com', 'fnos.com'].some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint">{hint}</span>}
    </label>
  );
}

function Toggle({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 w-4 h-4 accent-[rgb(var(--c-accent))]"
      />
      <span>
        <span className="text-sm block">{label}</span>
        {desc && <span className="text-xs text-faint">{desc}</span>}
      </span>
    </label>
  );
}
