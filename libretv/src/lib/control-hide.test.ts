import { describe, expect, it } from 'vitest';
import Artplayer from 'artplayer';
import {
  ART_DEFAULT_CONTROL_HIDE_MS,
  CONTROL_HIDE_MAX_MS,
  CONTROL_HIDE_MIN_MS,
  CONTROL_HIDE_NEVER,
  CONTROL_HIDE_OPTIONS,
  DESKTOP_CONTROL_HIDE_MS,
  TOUCH_CONTROL_HIDE_MS,
  artControlHideTime,
  resolveControlHideMs,
} from './control-hide';

describe('控制栏隐藏策略', () => {
  it('恢复基准与 ArtPlayer 库默认一致（升级依赖后若默认值变化会在此暴露）', () => {
    expect(ART_DEFAULT_CONTROL_HIDE_MS).toBe(Artplayer.CONTROL_HIDE_TIME);
  });

  it('桌面收紧到 800ms，快于库默认', () => {
    expect(DESKTOP_CONTROL_HIDE_MS).toBe(800);
    expect(DESKTOP_CONTROL_HIDE_MS).toBeLessThan(ART_DEFAULT_CONTROL_HIDE_MS);
  });

  it('触屏常驻：复刻 ArtPlayer 的 timeupdate 判定，永不满足隐藏条件', () => {
    // ArtPlayer: Date.now() - timer >= CONTROL_HIDE_TIME 时 hide
    const timer = Date.now();
    expect(Date.now() - timer >= TOUCH_CONTROL_HIDE_MS).toBe(false);
    // 即便计时器被异常修改到很久以前，也不会溢出成真
    expect(Date.now() - 0 >= TOUCH_CONTROL_HIDE_MS).toBe(false);
  });
});

describe('控制栏隐藏延迟设置', () => {
  it('合法值原样返回', () => {
    expect(resolveControlHideMs(500)).toBe(500);
    expect(resolveControlHideMs(1500)).toBe(1500);
    expect(resolveControlHideMs(5000)).toBe(5000);
  });

  it('0 表示不自动隐藏，不被当成非法值回落', () => {
    expect(resolveControlHideMs(CONTROL_HIDE_NEVER)).toBe(CONTROL_HIDE_NEVER);
  });

  it('缺失 / NaN / 字符串 / 负数一律回落到默认档（防脏数据把控制栏变常驻）', () => {
    expect(resolveControlHideMs(undefined)).toBe(DESKTOP_CONTROL_HIDE_MS);
    expect(resolveControlHideMs(null)).toBe(DESKTOP_CONTROL_HIDE_MS);
    expect(resolveControlHideMs(Number.NaN)).toBe(DESKTOP_CONTROL_HIDE_MS);
    expect(resolveControlHideMs('1500')).toBe(DESKTOP_CONTROL_HIDE_MS);
    expect(resolveControlHideMs(-1)).toBe(DESKTOP_CONTROL_HIDE_MS);
    expect(resolveControlHideMs(Number.POSITIVE_INFINITY)).toBe(DESKTOP_CONTROL_HIDE_MS);
  });

  it('越界值被夹到 [200, 60000]，避免「闪一下就没」或等于没隐藏', () => {
    expect(resolveControlHideMs(1)).toBe(CONTROL_HIDE_MIN_MS);
    expect(resolveControlHideMs(999999)).toBe(CONTROL_HIDE_MAX_MS);
  });

  it('小数会被取整，避免定时器收到 1500.7 这类值', () => {
    expect(resolveControlHideMs(1500.7)).toBe(1501);
  });

  it('0 映射为 ArtPlayer 的「永不到期」，其余原样透传', () => {
    expect(artControlHideTime(CONTROL_HIDE_NEVER)).toBe(TOUCH_CONTROL_HIDE_MS);
    expect(artControlHideTime(800)).toBe(800);
    expect(artControlHideTime(3000)).toBe(3000);
  });

  it('设置档位覆盖默认值且取值唯一', () => {
    const values = CONTROL_HIDE_OPTIONS.map((o) => o.value);
    expect(values).toContain(DESKTOP_CONTROL_HIDE_MS);
    expect(values).toContain(CONTROL_HIDE_NEVER);
    expect(new Set(values).size).toBe(values.length);
    // 所有档位都必须是合法值，否则选中后会被 resolve 改写成别的档
    for (const v of values) expect(resolveControlHideMs(v)).toBe(v);
  });
});
