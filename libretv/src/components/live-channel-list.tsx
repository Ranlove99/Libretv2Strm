'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import { Dropdown } from './dropdown';
import { useAppStore } from '@/lib/store';
import {
  isProbeFailed,
  isProbeNotOk,
  isSlowSource,
  matchesAlive,
  matchesKeyword,
  normalizeForSearch,
  sortChannels,
  type AliveFilter,
  type LiveSortMode,
} from '@/lib/live-channel-filter';
import { useLiveProbe, type ProbeResult } from './use-live-probe';
import { useToast } from './toast';
import type { LiveChannel } from '@/lib/types';
import { EmptyState } from './states';

/**
 * 直播频道侧栏：全部/收藏/最近/已屏蔽四个视图 + 分组横向标签条 + 关键字搜索 + 排序。
 * - 搜索对分隔符归一化（cctv1 命中 CCTV-1），并匹配分组名；输入防抖后过滤；
 * - 可用性两档筛选（绿点=分片级验证 / 可播=含弱验证）；
 * - 支持批量测活：频道名前显示可达性状态点；测完可「一键屏蔽失效」把确定不可达的频道收进已屏蔽视图；
 * - 编辑模式：手动上移/下移、重命名、改分组、删除（屏蔽），可一键恢复默认；
 * - 虚拟列表（@tanstack/react-virtual）：仅渲染可视区内的频道行，数千频道下 DOM 恒定，
 *   电视盒子 / 低端设备滑动不掉帧；行高动态测量（有无分组名两档）；
 * - 键盘：容器聚焦后 ↑↓ 移动光标、Enter 播放；
 * - 性能：本组件与 ChannelRow 均精确订阅 store，探测节流写回不会全列表重渲染。
 */

const SEARCH_DEBOUNCE_MS = 200;

/** 测活进度文案：按已完成均速估算剩余时间（长尾在途期间由每秒 tick 重渲染保持走动） */
function formatProbeProgress(p: { done: number; total: number; startedAt: number }): string {
  const base = `${p.done}/${p.total}`;
  const remaining = p.total - p.done;
  if (remaining <= 0) return base;
  if (p.done <= 0) return `${base} · 估算中…`;
  const remainMin = Math.ceil(((Date.now() - p.startedAt) / p.done) * remaining / 60000);
  return `${base} · 预计剩余 ${Math.max(1, remainMin)} 分钟`;
}

export interface LiveChannelItem extends LiveChannel {
  /** 来源订阅的 EPG 地址（用于节目单查询） */
  epg?: string;
  /** 所属直播源地址（M3U 订阅 URL），写入最近观看以便订阅删除时清理 */
  sourceUrl?: string;
}

interface ChannelListProps {
  channels: LiveChannelItem[];
  groups: string[];
  currentUrl: string;
  onSelect: (channel: LiveChannelItem) => void;
  /** 筛选+排序结果变化时上报（页面级键盘换台沿此列表顺序切换） */
  onFilteredChange?: (list: LiveChannelItem[]) => void;
}

type View = 'all' | 'fav' | 'recent' | 'blocked';

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * 分组标签条：鼠标按住拖动横向滚动 + 左右边缘渐隐。
 *
 * PC 上这条带子只能靠滚动条：`.scrollbar-thin` 把轨道压到 6px 高，
 * 分组一多滑块还会变短，实际点不中（上游 issue #948），所以补一套拖拽。
 * 触摸设备不接管：原生滑动带惯性，比手动跟手好。
 */
function useChipStrip(itemCount: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [edges, setEdges] = useState({ left: false, right: false });
  const drag = useRef({ startX: 0, startLeft: 0, moved: false });

  // 边缘渐隐：没有它，用户不知道右边还藏着分组
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      // 拖动时 scroll 事件很密：值没变就复用旧对象，避免每帧重渲染整个频道列表
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [itemCount]);

  // 拖动过程挂 document，而不是 setPointerCapture：
  // 一旦捕获指针，click 会被重定向到容器，点分组就失效了
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const dx = e.clientX - drag.current.startX;
      if (!drag.current.moved && Math.abs(dx) > 3) drag.current.moved = true;
      if (drag.current.moved) el.scrollLeft = drag.current.startLeft - dx;
    };
    const onUp = () => setDragging(false);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [dragging]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    drag.current = { startX: e.clientX, startLeft: el.scrollLeft, moved: false };
    setDragging(true);
  };

  // 拖完松手仍会触发一次 click，不能让它落到分组按钮上（等于误切分组）
  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!drag.current.moved) return;
    drag.current.moved = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { ref, dragging, edges, onPointerDown, onClickCapture };
}

export function LiveChannelList({ channels, groups, currentUrl, onSelect, onFilteredChange }: ChannelListProps) {
  // 精确订阅：避免任何 store 字段变化（尤其测活节流写回）引发本组件重渲染
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const liveRecent = useAppStore((s) => s.liveRecent);
  const liveBlockedUrls = useAppStore((s) => s.liveBlockedUrls);
  const liveChannelOrder = useAppStore((s) => s.liveChannelOrder);
  const liveChannelEdits = useAppStore((s) => s.liveChannelEdits);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const { toast } = useToast();

  const [view, setView] = useState<View>('all');
  const [group, setGroup] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const debouncedKeyword = useDebouncedValue(keyword, SEARCH_DEBOUNCE_MS);
  const [sortMode, setSortMode] = useState<LiveSortMode>('default');
  const [aliveFilter, setAliveFilter] = useState<AliveFilter>('off');
  /** 编辑模式：行内出现上移/下移/编辑/删除按钮 */
  const [editMode, setEditMode] = useState(false);
  /** 正在编辑的频道（重命名 / 改分组弹窗） */
  const [editingChannel, setEditingChannel] = useState<LiveChannelItem | null>(null);
  /** 键盘光标（filtered 的下标），与"正在播放"高亮独立 */
  const [cursor, setCursor] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  /** 分组标签条的拖拽滚动与边缘渐隐 */
  const chipStrip = useChipStrip(groups.length);
  const {
    results: probeResults,
    progress: probeProgress,
    probe,
    cancel: cancelProbe,
    clear: clearProbe,
    isProbing,
    hint: probeHint,
  } = useLiveProbe();

  // 测活 ETA 每秒刷新：探测长尾（在途请求未返回）期间进度不推进，剩余时间也要走动
  const [, setProbeTick] = useState(0);
  useEffect(() => {
    if (!isProbing) return;
    const timer = setInterval(() => setProbeTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isProbing]);

  const favSet = useMemo(() => new Set(liveFavorites), [liveFavorites]);
  const blockedSet = useMemo(() => new Set(liveBlockedUrls), [liveBlockedUrls]);
  const recentOrder = useMemo(() => new Map(liveRecent.map((r, i) => [r.url, i] as const)), [liveRecent]);
  const customOrder = useMemo(
    () => new Map(liveChannelOrder.map((u, i) => [u, i] as const)),
    [liveChannelOrder]
  );
  const normalizedKeyword = useMemo(() => normalizeForSearch(debouncedKeyword.trim()), [debouncedKeyword]);

  // 先做视图/分组/搜索/排序（不含可用性筛选）：可用性计数必须基于这份列表，
  // 否则点击筛选后 filtered 收缩，两个计数会跟着变小、与实际展示对不上
  const matched = useMemo(() => {
    let list: LiveChannelItem[];
    if (view === 'blocked') {
      // 已屏蔽视图只列被屏蔽的频道，供逐个/整体恢复
      list = channels.filter((c) => blockedSet.has(c.url));
    } else if (view === 'fav') {
      list = channels.filter((c) => favSet.has(c.url) && !blockedSet.has(c.url));
    } else if (view === 'recent') {
      // 按最近观看时间倒序
      list = liveRecent
        .map((r) => channels.find((c) => c.url === r.url))
        .filter((c): c is LiveChannelItem => c !== undefined && !blockedSet.has(c.url));
    } else {
      list = channels.filter((c) => !blockedSet.has(c.url));
    }
    if (view !== 'recent' && view !== 'blocked' && group) {
      list = list.filter((c) => c.group === group);
    }
    if (normalizedKeyword) {
      list = list.filter((c) => matchesKeyword(c, normalizedKeyword));
    }
    return sortChannels(list, sortMode, {
      recentOrder,
      customOrder,
      probeOf: (url) => probeResults.get(url),
    });
  }, [
    channels,
    favSet,
    blockedSet,
    liveRecent,
    view,
    group,
    normalizedKeyword,
    sortMode,
    recentOrder,
    customOrder,
    probeResults,
  ]);

  const filtered = useMemo(
    () =>
      aliveFilter === 'off'
        ? matched
        : matched.filter((c) => matchesAlive(probeResults.get(c.url), aliveFilter)),
    [matched, aliveFilter, probeResults]
  );

  // 上报筛选排序结果给页面（键盘换台用）；列表存父组件 ref，不触发父组件重渲染
  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  // 口径与两个筛选按钮一致：绿点=分片级验证且吞吐达标（排除限速源），可播=任何验证级别通过
  const aliveCounts = useMemo(() => {
    let ok = 0;
    let green = 0;
    for (const c of matched) {
      const p = probeResults.get(c.url);
      if (!p?.ok) continue;
      ok++;
      if (matchesAlive(p, 'green')) green++;
    }
    return { ok, green };
  }, [matched, probeResults]);

  // 键盘/锚定滚动需要按 URL 反查索引；filtered 随测活结果变化（排序含可用性），
  // 用 ref 读取最新值，避免测活写回触发重新锚定打断用户滚动
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    // 行高两档：带分组名的双行 / 无分组名单行（含 4px 行距），measureElement 会修正估值
    estimateSize: (i) => (filtered[i].group ? 51 : 47),
    overscan: 10,
    getItemKey: (i) => filtered[i].url,
  });

  // 切换筛选/排序/频道时：重置键盘光标，并把当前播放频道锚定到可视区（找不到则回顶部）
  useEffect(() => {
    setCursor(-1);
    if (!currentUrl) {
      virtualizer.scrollToOffset(0);
      return;
    }
    const idx = filteredRef.current.findIndex((c) => c.url === currentUrl);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
    else virtualizer.scrollToOffset(0);
  }, [view, group, sortMode, debouncedKeyword, aliveFilter, currentUrl, virtualizer]);

  const scrollToChannelRow = useCallback(
    (url: string) => {
      const idx = filteredRef.current.findIndex((c) => c.url === url);
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
    },
    [virtualizer]
  );

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const base = cursor === -1 ? (delta === 1 ? -1 : 0) : cursor;
      const next = Math.min(Math.max(base + delta, 0), filtered.length - 1);
      setCursor(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
      return;
    }
    if (e.key === 'Enter' && cursor >= 0 && cursor < filtered.length) {
      // 焦点在行内按钮（收藏/删除）上时，Enter 交给按钮自身
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      onSelect(filtered[cursor]);
    }
  };

  const removeRecent = useCallback((url: string) => {
    useAppStore.getState().removeLiveRecent(url);
  }, []);

  /** 当前视图内「确定失效」的频道：一键屏蔽的目标（超时的不算，避免误伤慢源） */
  const failedChannels = useMemo(
    () => matched.filter((c) => isProbeFailed(probeResults.get(c.url))),
    [matched, probeResults]
  );
  /** 测过但没通过、且只是超时的数量（屏蔽时提示用户） */
  const timedOutCount = useMemo(
    () => matched.filter((c) => isProbeNotOk(probeResults.get(c.url)) && !isProbeFailed(probeResults.get(c.url))).length,
    [matched, probeResults]
  );

  /** 一键屏蔽失效频道（可撤销） */
  const blockFailed = useCallback(() => {
    const urls = failedChannels.map((c) => c.url);
    if (urls.length === 0) return;
    useAppStore.getState().blockLiveChannels(urls);
    toast(
      `已屏蔽 ${urls.length} 个失效频道${timedOutCount > 0 ? `；另有 ${timedOutCount} 个超时频道未屏蔽（源可能只是慢）` : ''}`,
      'success',
      {
        action: {
          label: '撤销',
          onClick: () => useAppStore.getState().unblockLiveChannels(urls),
        },
      }
    );
  }, [failedChannels, timedOutCount, toast]);

  /** 从「已屏蔽」视图恢复 */
  const unblockOne = useCallback(
    (url: string) => {
      useAppStore.getState().unblockLiveChannels([url]);
      toast('已恢复该频道', 'success');
    },
    [toast]
  );

  const restoreAllBlocked = useCallback(() => {
    const urls = useAppStore.getState().liveBlockedUrls;
    if (urls.length === 0) return;
    useAppStore.getState().clearLiveBlocked();
    toast(`已恢复 ${urls.length} 个频道`, 'success', {
      action: {
        label: '撤销',
        onClick: () => useAppStore.getState().blockLiveChannels(urls),
      },
    });
  }, [toast]);

  /**
   * 手动排序：把「当前展示顺序」固化成自定义顺序后交换相邻两项。
   * 以 filtered 为准（用户看到什么顺序就按什么顺序排），未出现在 filtered 的频道按原次序补在后面。
   */
  const moveChannel = useCallback(
    (url: string, delta: 1 | -1) => {
      const shown = filtered.map((c) => c.url);
      const shownSet = new Set(shown);
      const rest = channels.filter((c) => !shownSet.has(c.url)).map((c) => c.url);
      const order = [...shown, ...rest];
      const from = order.indexOf(url);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= order.length) return;
      [order[from], order[to]] = [order[to], order[from]];
      useAppStore.getState().setLiveChannelOrder(order);
      // 移动即意味着「按我排的来」：自动切到自定义排序，否则排序规则会立刻覆盖手工顺序
      setSortMode('custom');
    },
    [filtered, channels]
  );

  /** 删除（= 屏蔽）：不动订阅本身，可在已屏蔽视图恢复 */
  const deleteChannel = useCallback(
    (channel: LiveChannelItem) => {
      useAppStore.getState().blockLiveChannels([channel.url]);
      toast(`已删除「${channel.name}」（可在「已屏蔽」中恢复）`, 'info', {
        action: {
          label: '撤销',
          onClick: () => useAppStore.getState().unblockLiveChannels([channel.url]),
        },
      });
    },
    [toast]
  );

  /** 一键恢复全部手工编辑（重命名 / 分组 / 自定义顺序），不影响屏蔽列表 */
  const resetEdits = useCallback(() => {
    const prevEdits = useAppStore.getState().liveChannelEdits;
    const prevOrder = useAppStore.getState().liveChannelOrder;
    if (Object.keys(prevEdits).length === 0 && prevOrder.length === 0) return;
    useAppStore.getState().resetLiveChannelEdits();
    setSortMode('default');
    toast('已恢复默认名称与顺序', 'success', {
      action: {
        label: '撤销',
        onClick: () => {
          const s = useAppStore.getState();
          for (const [url, patch] of Object.entries(prevEdits)) s.editLiveChannel(url, patch);
          s.setLiveChannelOrder(prevOrder);
        },
      },
    });
  }, [toast]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 视图 tab */}
      <div className="flex items-center gap-1 px-3 pt-2.5 pb-2 border-b border-line shrink-0 overflow-x-auto scrollbar-thin">
        {(
          [
            ['all', `全部${channels.length ? ` ${channels.length - blockedSet.size}` : ''}`],
            ['fav', `收藏${liveFavorites.length ? ` ${liveFavorites.length}` : ''}`],
            ['recent', '最近'],
            ...(liveBlockedUrls.length > 0
              ? ([['blocked', `已屏蔽 ${liveBlockedUrls.length}`]] as [View, string][])
              : []),
          ] as [View, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            className={cn(
              'shrink-0 px-2.5 py-1 rounded-md text-xs transition-colors whitespace-nowrap',
              view === v ? 'bg-accent/10 text-accent font-medium' : 'text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 搜索 + 排序 */}
      <div className="px-3 py-2 shrink-0 flex items-center gap-1.5">
        <input
          className="input w-full !py-1.5 text-xs"
          placeholder="搜索频道 / tvg-id / 分组..."
          value={keyword}
          maxLength={60}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            // 搜索框内按 ↓ 进入列表光标导航
            if (e.key === 'ArrowDown' && filtered.length > 0) {
              e.preventDefault();
              setCursor(0);
              scrollToChannelRow(filtered[0].url);
              listRef.current?.focus();
            }
          }}
        />
        <Dropdown
          className="shrink-0 [&>button]:!py-1.5 [&>button]:!px-2 [&>button]:text-xs"
          value={sortMode}
          ariaLabel="排序方式"
          onChange={(v) => setSortMode(v as LiveSortMode)}
          options={[
            { value: 'default', label: '默认' },
            { value: 'name', label: '名称' },
            { value: 'group', label: '分组' },
            { value: 'probe', label: '可用优先' },
            { value: 'recent', label: '最近看' },
            { value: 'custom', label: '自定义' },
          ]}
        />
      </div>

      {/* 测活 / 屏蔽 / 编辑 工具条 */}
      <div className="flex items-center gap-1.5 px-3 pb-2 shrink-0 flex-wrap">
        <button
          className="btn-ghost btn-sm"
          disabled={isProbing || filtered.length === 0}
          onClick={() => void probe(filtered)}
          title="一键测活：探测当前列表里的频道能否播放（分片级校验；量大时自动分批排队跑完，结果 6 小时内有效）"
        >
          一键测活
        </button>
        {/* 同一操作位按时机切换：测活中=取消（保留已完成结果）；空闲且有结果=清除全部 */}
        {isProbing ? (
          <button
            className="btn-ghost btn-sm"
            onClick={cancelProbe}
            title="中止本次测活，已完成的结果会保留"
          >
            取消
          </button>
        ) : (
          probeResults.size > 0 && (
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                clearProbe();
                setAliveFilter('off');
              }}
              title="清除全部测活结果，并取消可用性筛选"
            >
              清除
            </button>
          )
        )}
        {/* 一键屏蔽失效：测完之后才有意义，故与结果数量联动 */}
        {!isProbing && probeResults.size > 0 && view !== 'blocked' && (
          <button
            className="btn-ghost btn-sm"
            disabled={failedChannels.length === 0}
            onClick={blockFailed}
            title={
              failedChannels.length > 0
                ? `把测活确定不可达的 ${failedChannels.length} 个频道移入「已屏蔽」（可在该视图恢复；超时频道不在此列）`
                : '当前列表没有测活确定失效的频道'
            }
          >
            屏蔽失效{failedChannels.length > 0 ? ` ${failedChannels.length}` : ''}
          </button>
        )}
        {view === 'blocked' && (
          <button
            className="btn-ghost btn-sm"
            disabled={liveBlockedUrls.length === 0}
            onClick={restoreAllBlocked}
            title="把已屏蔽的频道全部恢复到列表中"
          >
            全部恢复
          </button>
        )}
        {/* 编辑模式：行内出现上移/下移/编辑/删除 */}
        {view !== 'blocked' && (
          <button
            className={cn(
              'btn-ghost btn-sm',
              editMode && 'border-accent text-accent'
            )}
            onClick={() => setEditMode((v) => !v)}
            aria-pressed={editMode}
            title="编辑播放列表：手动调整顺序、重命名、改分组、删除频道"
          >
            {editMode ? '完成' : '编辑'}
          </button>
        )}
        {editMode && (
          <button className="btn-ghost btn-sm" onClick={resetEdits} title="恢复全部频道的默认名称、分组与顺序">
            恢复默认
          </button>
        )}
        {isProbing && probeProgress && (
          <span className="text-[10px] text-faint whitespace-nowrap">
            探测中 {formatProbeProgress(probeProgress)}
          </span>
        )}
        {probeHint && (
          <span className="text-[10px] text-faint">{probeHint}</span>
        )}
        {probeResults.size > 0 && !isProbing && (
          <>
            <button
              className={cn(
                'shrink-0 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap transition-colors border',
                aliveFilter === 'green'
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
              )}
              onClick={() => setAliveFilter((v) => (v === 'green' ? 'off' : 'green'))}
              title="只看分片级验证通过的频道"
            >
              绿点 {aliveCounts.green}
            </button>
            <button
              className={cn(
                'shrink-0 px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap transition-colors border',
                aliveFilter === 'ok'
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
              )}
              onClick={() => setAliveFilter((v) => (v === 'ok' ? 'off' : 'ok'))}
              title="看所有验证通过（含直链/清单级弱验证）的频道"
            >
              可播 {aliveCounts.ok}
            </button>
          </>
        )}
      </div>

      {/* 分组标签条（横向可滑动：滚轮/滚动条之外，鼠标可直接拖动） */}
      {view === 'all' && groups.length > 0 && (
        <div className="px-3 pb-2 shrink-0">
          <div className="relative">
            <div
              ref={chipStrip.ref}
              onPointerDown={chipStrip.onPointerDown}
              onClickCapture={chipStrip.onClickCapture}
              className={cn(
                // select-none 常驻：拖动时若允许选字，会变成"选中标签文字"而不是滚动
                'flex gap-1.5 overflow-x-auto scrollbar-thin pb-1 select-none',
                chipStrip.dragging ? 'cursor-grabbing' : 'cursor-grab'
              )}
            >
              <GroupChip active={!group} label="全部分组" onClick={() => setGroup('')} />
              {groups.map((g) => (
                <GroupChip key={g} active={group === g} label={g} onClick={() => setGroup(g === group ? '' : g)} />
              ))}
            </div>
            {/* 左右渐隐：提示这一栏还能横向拖动 */}
            {chipStrip.edges.left && (
              <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface-raised to-transparent" />
            )}
            {chipStrip.edges.right && (
              <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface-raised to-transparent" />
            )}
          </div>
        </div>
      )}

      {/* 频道列表（容器可聚焦，↑↓/Enter 光标导航） */}
      <div
        ref={listRef}
        data-channel-list
        tabIndex={0}
        onKeyDown={onListKeyDown}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        {filtered.length === 0 ? (
          <EmptyState
            variant="plain"
            className="!py-10"
            title={
              view === 'fav'
                ? '暂无收藏频道，点击频道右侧星标即可收藏'
                : view === 'recent'
                  ? '暂无观看记录'
                  : view === 'blocked'
                    ? '没有已屏蔽的频道'
                    : channels.length === 0
                      ? '暂无频道，请先在设置中添加直播源'
                      : aliveFilter !== 'off' && probeResults.size > 0
                        ? '没有匹配该可用性的频道，可放宽或清除筛选'
                        : '没有匹配的频道'
            }
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                  // 原 space-y-1 的 4px 行距；padding 计入 measureElement 量得的高度
                  paddingBottom: 4,
                }}
              >
                <ChannelRow
                  channel={filtered[vi.index]}
                  active={filtered[vi.index].url === currentUrl}
                  cursor={cursor === vi.index}
                  isFav={favSet.has(filtered[vi.index].url)}
                  isEdited={Boolean(liveChannelEdits[filtered[vi.index].url])}
                  probe={probeResults.get(filtered[vi.index].url)}
                  logo={filtered[vi.index].logo}
                  imageProxyMode={imageProxyMode}
                  customProxy={customImageProxy}
                  onSelect={onSelect}
                  onRemoveRecent={view === 'recent' ? removeRecent : undefined}
                  editMode={editMode && view !== 'blocked'}
                  onMove={moveChannel}
                  onEditChannel={setEditingChannel}
                  onDeleteChannel={deleteChannel}
                  onUnblock={view === 'blocked' ? unblockOne : undefined}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {editingChannel && (
        <ChannelEditDialog channel={editingChannel} onClose={() => setEditingChannel(null)} />
      )}
    </div>
  );
}

function GroupChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={cn(
        'shrink-0 px-2.5 py-1 rounded-full text-xs whitespace-nowrap transition-colors border',
        active
          ? 'bg-accent text-on-accent border-accent'
          : 'bg-chip text-muted border-line hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * 频道编辑弹窗：重命名 / 改分组。
 * 用弹窗而非行内输入框：虚拟列表的行高由 measureElement 动态测量，
 * 行内插入输入框会引起高度抖动与滚动锚定跳动，弹窗没有这个问题。
 */
function ChannelEditDialog({ channel, onClose }: { channel: LiveChannelItem; onClose: () => void }) {
  const saved = useAppStore((s) => s.liveChannelEdits[channel.url]);
  const [name, setName] = useState(saved?.name ?? channel.name);
  const [group, setGroup] = useState(saved?.group ?? channel.group ?? '');
  const { toast } = useToast();

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast('频道名称不能为空', 'warning');
      return;
    }
    useAppStore.getState().editLiveChannel(channel.url, { name: trimmed, group });
    onClose();
  };

  const reset = () => {
    useAppStore.getState().resetLiveChannelEdit(channel.url);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="编辑频道"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-surface-raised border border-line rounded-xl p-4 space-y-3 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-content">编辑频道</h3>
        <label className="block space-y-1">
          <span className="text-xs text-muted">名称</span>
          <input
            className="input w-full text-sm"
            value={name}
            maxLength={60}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') onClose();
            }}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-muted">分组</span>
          <input
            className="input w-full text-sm"
            value={group}
            maxLength={40}
            placeholder="留空则归入「未分组」"
            onChange={(e) => setGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') onClose();
            }}
          />
        </label>
        <p className="text-[11px] text-faint break-all">地址：{channel.url}</p>
        <div className="flex items-center gap-2 justify-end pt-1">
          {saved && (
            <button className="btn-ghost btn-sm mr-auto" onClick={reset} title="恢复 M3U 里的原始名称与分组">
              恢复默认
            </button>
          )}
          <button className="btn-ghost btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary btn-sm" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

const ChannelRow = memo(function ChannelRow({
  channel,
  active,
  cursor,
  isFav,
  isEdited,
  probe,
  logo,
  imageProxyMode,
  customProxy,
  onSelect,
  onRemoveRecent,
  editMode,
  onMove,
  onEditChannel,
  onDeleteChannel,
  onUnblock,
}: {
  channel: LiveChannelItem;
  active: boolean;
  cursor: boolean;
  isFav: boolean;
  /** 名称/分组被手工编辑过（行上给个标记，便于识别） */
  isEdited: boolean;
  probe?: ProbeResult;
  logo?: string;
  imageProxyMode: 'direct' | 'proxy' | 'custom';
  customProxy: string;
  onSelect: (channel: LiveChannelItem) => void;
  /** 仅最近视图传入：删除该条观看记录 */
  onRemoveRecent?: (url: string) => void;
  /** 编辑模式：行内显示上移/下移/编辑/删除 */
  editMode?: boolean;
  onMove?: (url: string, delta: 1 | -1) => void;
  onEditChannel?: (channel: LiveChannelItem) => void;
  onDeleteChannel?: (channel: LiveChannelItem) => void;
  /** 仅已屏蔽视图传入：恢复该频道 */
  onUnblock?: (url: string) => void;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  // 虚拟列表会复用行实例：换台（logo 变化）时重置失败态，避免下一个频道误显首字母
  useEffect(() => setLogoFailed(false), [logo]);
  // H.265/HEVC：国内 IPTV 常见，测活通过但 Chromium 内核通常无法软解
  const isHevc = Boolean(probe?.codec && /hvc1|hev1|hevc/i.test(probe.codec));
  // 源限速：分片可达但吞吐不足，绿点却播不了的主因
  const slow = isSlowSource(probe);
  // 状态点语义：绿=分片级验证且吞吐达标；琥珀=限速/弱验证（直链/清单级）或超时；红=不可达
  const weakLevel = probe?.ok && probe.level !== 'segment';
  const amber = Boolean(probe && (weakLevel || (!probe.ok && probe.timedOut) || slow));
  const dotClass = amber ? 'bg-warning' : probe?.ok ? 'bg-success' : 'bg-danger';
  const levelText =
    probe?.level === 'segment'
      ? '分片可用'
      : probe?.level === 'head'
        ? '直链可达（未验证可播性）'
        : '播放列表可达（无分片，未验证可播）';
  const speedText =
    probe?.kbps != null && probe.level === 'segment'
      ? ` · ≈${probe.kbps >= 1000 ? `${(probe.kbps / 1000).toFixed(1)}Mbps` : `${probe.kbps}kbps`}`
      : '';
  const probeTitle = probe
    ? probe.ok
      ? slow
        ? `源限速${speedText.replace(' · ', ' ')}，缓冲跟不上，可能无法流畅播放`
        : `${levelText}${speedText}${probe.ms != null && probe.level === 'segment' ? ` · 延迟 ${probe.ms}ms` : ''}${isHevc ? ' · H.265 编码，需 Edge/Safari' : ''}`
      : probe.timedOut
        ? `${probe.error || '探测超时'} · 源可能只是慢，可直接试播确认`
        : probe.error || '不可用'
    : undefined;

  return (
    <div data-url={channel.url}>
      {/* 不用 role="button"：行内含收藏/删除等真实按钮，嵌套 button 角色语义非法；
          键盘操作由外层列表容器的 ↑↓ 导航提供 */}
      <div
        className={cn(
          'group flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer transition-colors relative',
          active ? 'bg-accent/10' : 'hover:bg-hover',
          cursor && 'ring-1 ring-accent/70'
        )}
        onClick={() => onSelect(channel)}
      >
        {/* 当前播放高亮竖条 */}
        <span
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full bg-accent transition-all duration-200',
            active ? 'h-5 opacity-100' : 'h-0 opacity-0'
          )}
        />
        {/* 台标 */}
        <div className="w-7 h-7 shrink-0 rounded bg-chip flex items-center justify-center overflow-hidden">
          {logo && !logoFailed ? (
            <SmartImage
              url={logo}
              mode={imageProxyMode}
              customProxy={customProxy}
              alt=""
              className="w-full h-full object-contain"
              onExhausted={() => setLogoFailed(true)}
            />
          ) : (
            <span className="text-[10px] text-faint">{channel.name.slice(0, 1)}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {probe && (
              <span
                className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotClass)}
                title={probeTitle}
              />
            )}
            <span className={cn('text-xs truncate', active ? 'text-accent font-medium' : 'text-content')}>
              {channel.name}
            </span>
            {isEdited && (
              <span
                className="shrink-0 text-[10px] text-accent/80"
                title="名称或分组已被手动编辑"
                aria-label="已编辑"
              >
                ✎
              </span>
            )}
            {isHevc && (
              <span
                className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[10px] font-medium text-warning"
                title="H.265 编码：测活通过但 Chromium 内核通常无法解码，建议用 Edge/Safari"
              >
                H.265
              </span>
            )}
          </div>
          {channel.group && (
            <div className="text-[10px] text-faint truncate">{channel.group}</div>
          )}
        </div>
        {/* 编辑模式：上移 / 下移 / 编辑 / 删除（删除=屏蔽，可在「已屏蔽」恢复） */}
        {editMode ? (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              className="shrink-0 p-1 rounded text-faint hover:text-accent hover:bg-hover transition-colors"
              aria-label="上移"
              title="上移（切换到自定义排序）"
              onClick={(e) => {
                e.stopPropagation();
                onMove?.(channel.url, -1);
              }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <button
              className="shrink-0 p-1 rounded text-faint hover:text-accent hover:bg-hover transition-colors"
              aria-label="下移"
              title="下移（切换到自定义排序）"
              onClick={(e) => {
                e.stopPropagation();
                onMove?.(channel.url, 1);
              }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <button
              className="shrink-0 p-1 rounded text-faint hover:text-accent hover:bg-hover transition-colors"
              aria-label="编辑名称与分组"
              title="重命名 / 改分组"
              onClick={(e) => {
                e.stopPropagation();
                onEditChannel?.(channel);
              }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
            </button>
            <button
              className="shrink-0 p-1 rounded text-faint hover:text-danger hover:bg-hover transition-colors"
              aria-label="删除频道"
              title="从列表中删除（可在「已屏蔽」里恢复）"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteChannel?.(channel);
              }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          </div>
        ) : (
          <>
            {/* 已屏蔽视图：恢复该频道 */}
            {onUnblock && (
              <button
                className="shrink-0 px-1.5 py-0.5 rounded text-[10px] border border-line text-muted hover:text-accent hover:border-accent transition-colors"
                aria-label="恢复该频道"
                title="恢复到频道列表"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnblock(channel.url);
                }}
              >
                恢复
              </button>
            )}
            {/* 最近观看单条删除（仅最近视图；移动端常显） */}
            {onRemoveRecent && (
              <button
                className={cn(
                  'shrink-0 p-1 rounded transition-colors',
                  'text-faint/60 opacity-60 lg:opacity-0 lg:group-hover:opacity-100 hover:text-danger'
                )}
                aria-label="删除该观看记录"
                title="删除该观看记录"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveRecent(channel.url);
                }}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            {/* 收藏星标（移动端常显，桌面 hover 出现） */}
            <button
              className={cn(
                'shrink-0 p-1 rounded transition-transform active:scale-125',
                isFav
                  ? 'text-warning'
                  : 'text-faint/60 opacity-60 lg:opacity-0 lg:group-hover:opacity-100 hover:text-warning'
              )}
              aria-label={isFav ? '取消收藏' : '收藏'}
              title={isFav ? '取消收藏' : '收藏'}
              onClick={(e) => {
                e.stopPropagation();
                // 点击时读取最新状态：行组件不订阅 store，保证探测期间的重渲染隔离
                useAppStore.getState().toggleLiveFavorite(channel.url);
              }}
            >
              <svg className="w-3.5 h-3.5" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
});
