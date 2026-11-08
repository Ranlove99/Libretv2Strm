'use client';

import { useRef, useState } from 'react';
import { Icon } from './icon';
import { useToast } from './toast';
import { useAppStore } from '@/lib/store';
import { parseSourceFile, pickSourcesFor, type SourceFileKind } from '@/lib/source-file-import';
import { cn } from '@/lib/utils';

/** 源文件体积上限：源列表是纯文本，正常几十 KB；超过这个量级基本是选错了文件 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 「从文件导入」按钮：点播源面板与直播源面板各挂一个，只吃自己那一半。
 *
 * 用隐藏的 `<input type="file">` 而不是拖拽区——源列表面板本身已经很长，
 * 再铺一块拖拽区会把列表往下挤，而导入是低频操作。
 */
export function SourceFileImportButton({
  kind,
  className,
}: {
  kind: SourceFileKind;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const importCustomApis = useAppStore((s) => s.importCustomApis);
  const importLiveSubscriptions = useAppStore((s) => s.importLiveSubscriptions);
  const [busy, setBusy] = useState(false);

  const label = kind === 'vod' ? '点播源' : '直播源';

  const handleFile = async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      toast(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB，可能选错了文件`, 'warning');
      return;
    }
    setBusy(true);
    try {
      const parsed = parseSourceFile(await file.text(), kind);
      const picked = pickSourcesFor(parsed, kind);
      const result =
        kind === 'vod'
          ? importCustomApis(picked.vod)
          : importLiveSubscriptions(picked.live);

      if (result.added === 0) {
        toast(
          result.duplicated > 0
            ? `这 ${result.duplicated} 个${label}都已经在列表里了`
            : `没有可导入的${label}`,
          'warning'
        );
      } else {
        const dup = result.duplicated > 0 ? `，跳过 ${result.duplicated} 个已存在` : '';
        toast(`已导入 ${result.added} 个${label}${dup}`, 'success');
      }

      // 文件里还有另一半时明确指路，避免用户以为「只导进去一半」是 bug
      if (parsed.otherCount > 0) {
        const other = kind === 'vod' ? '直播源' : '点播源';
        toast(`这个文件里还有 ${parsed.otherCount} 个${other}，请到「${other}」面板再导入一次`, 'warning');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error');
    } finally {
      setBusy(false);
      // 清空 value：同一个文件改完再选一次也能触发 change
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-label={`从文件导入${label}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <button
        className={cn('btn-ghost btn-sm', className)}
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title={`选择一份 JSON 文件导入${label}（LibreTV 源列表 / TVBOX 配置 / 接口目录）`}
      >
        <Icon name="upload" className="w-3.5 h-3.5" />
        {busy ? '导入中…' : '从文件导入'}
      </button>
    </>
  );
}
