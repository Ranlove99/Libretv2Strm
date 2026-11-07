'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useToast } from '@/components/toast';
import { Spinner } from '@/components/states';
import { cn } from '@/lib/utils';
import type { StrmConfig } from '@/lib/strm/types';

/** 设置面板：输出目录 / URL 模式 / 命名模板 / NFO 与海报开关 */

export function StrmSettingsPanel() {
  const { toast } = useToast();
  const configQuery = useQuery({
    queryKey: ['strm-config'],
    queryFn: () => api.strmConfig(),
    staleTime: 30 * 1000,
  });

  const [form, setForm] = useState<StrmConfig | null>(null);
  const [saving, setSaving] = useState(false);

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
