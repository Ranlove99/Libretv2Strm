'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized, STATUS_QUERY_KEY } from '@/lib/client-api';
import { applyEnvPresets } from '@/lib/subscription-sync';
import type { AuthStatusResponse } from '@/lib/types';
import { useToast } from './toast';

/**
 * 认证上下文：
 * - 页面加载时查询 /api/status 判断会话有效性；
 * - 任何 API 返回 401/503 时全局打开登录框（客户端 API 层统一触发，不再散落检查）。
 */

type SetupRequired = boolean;

interface AuthContextValue {
  checked: boolean;
  verified: boolean;
  /** 服务器未设置 PASSWORD，需要管理员配置 */
  setupRequired: SetupRequired;
  /** /api/status 返回的应用版本（构建时从 package.json 注入） */
  version: string | null;
  openLogin: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  checked: false,
  verified: false,
  setupRequired: false,
  version: null,
  openLogin: () => {},
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [verified, setVerified] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // 与 Providers 共用同一 query key 与缓存，避免 /api/status 被请求两次
  useEffect(() => {
    let cancelled = false;
    queryClient
      .fetchQuery({ queryKey: STATUS_QUERY_KEY, queryFn: () => api.status() })
      .then((s) => {
        if (cancelled) return;
        setVerified(s.verified);
        setSetupRequired(!s.passwordRequired);
        setVersion(s.version);
        setChecked(true);
      })
      .catch(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  useEffect(
    () =>
      onUnauthorized((event) => {
        const setup = (event as CustomEvent).detail === 'setup';
        setSetupRequired(setup);
        setVerified(false);
        setModalOpen(true);
      }),
    []
  );

  // 未验证就主动弹框，不能等页面自己发 401：
  // 直播页首屏在 verified=false 时不发任何请求（`enabled: verified && ...`），
  // 用户会被永久卡在「等待访问验证...」，连输密码的入口都没有。
  // 同理，首次打开（还没设密码）也必须直接给出设置密码的表单。
  useEffect(() => {
    if (!checked) return;
    setModalOpen(!verified);
  }, [checked, verified]);

  const openLogin = useCallback(() => setModalOpen(true), []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setVerified(false);
      toast('已退出登录', 'info');
    }
  }, [toast]);

  const handleLoginSuccess = useCallback(async () => {
    setVerified(true);
    setSetupRequired(false);
    setModalOpen(false);
    // 登录前以 401 失败的查询（如豆瓣推荐）需要重新拉取
    queryClient.invalidateQueries();
    toast('验证成功', 'success');
    // 预置订阅（DEFAULT_SUBSCRIPTIONS）的首屏同步发生在登录之前，会 401 静默失败，
    // 这里用缓存中的 /api/status 补跑一次（缓存缺失时回落为一次请求）
    try {
      const cached = queryClient.getQueryData<AuthStatusResponse>(STATUS_QUERY_KEY);
      const status =
        cached ??
        (await queryClient.fetchQuery<AuthStatusResponse>({
          queryKey: STATUS_QUERY_KEY,
          queryFn: () => api.status(),
          staleTime: 0,
        }));
      if (status) await applyEnvPresets(status, { verified: true });
    } catch {
      // 补拉预置数据失败不影响登录后的正常使用
    }
  }, [toast, queryClient]);

  return (
    <AuthContext.Provider value={{ checked, verified, setupRequired, version, openLogin, logout }}>
      {children}
      {modalOpen && (
        <LoginModal
          setupRequired={setupRequired}
          onSuccess={handleLoginSuccess}
          onClose={() => setModalOpen(false)}
        />
      )}
    </AuthContext.Provider>
  );
}

function LoginModal({
  setupRequired,
  onSuccess,
  onClose,
}: {
  setupRequired: boolean;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const submit = async () => {
    if (!password.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '验证失败';
      setError(msg === '需要登录' ? '密码错误' : msg);
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  const submitSetup = async () => {
    if (loading) return;
    const pw = password.trim();
    if (!pw) {
      setError('请输入访问密码');
      return;
    }
    if (pw !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await api.setupPassword(pw, confirm);
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '设置失败';
      setError(msg);
      setPassword('');
      setConfirm('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-surface-raised rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={setupRequired ? '设置访问密码' : '访问验证'}
      >
        {setupRequired ? (
          <>
            <h2 className="text-lg font-semibold text-content mb-1">设置访问密码</h2>
            <p className="text-sm text-muted mb-4">
              这是首次打开 LibreTV，还没有设置访问密码。请先设置一个用于登录 Web 界面的密码
              （4-64 个字符），设置后立即进入。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitSetup();
              }}
            >
              <input
                ref={inputRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full"
                placeholder="访问密码（4-64 个字符）"
                autoComplete="new-password"
              />
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="input w-full mt-2"
                placeholder="再输一次确认"
                autoComplete="new-password"
              />
              {error && <p className="mt-2 text-sm text-danger">{error}</p>}
              <button type="submit" className="btn-primary w-full mt-4" disabled={loading || !password.trim()}>
                {loading ? '设置中...' : '设置并进入'}
              </button>
            </form>
            <p className="mt-3 text-xs text-faint leading-relaxed">
              密码保存在应用数据目录中，重启与升级都不会丢失。
              之后如需修改，可在应用中心的「设置 → 修改访问密码」中操作。
            </p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-content mb-1">访问验证</h2>
            <p className="text-sm text-muted mb-4">请输入密码继续访问</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                ref={inputRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full"
                placeholder="密码"
                autoComplete="current-password"
              />
              {error && <p className="mt-2 text-sm text-danger">{error}</p>}
              <button type="submit" className="btn-primary w-full mt-4" disabled={loading || !password.trim()}>
                {loading ? '验证中...' : '进入'}
              </button>
            </form>
            <p className="mt-3 text-xs text-faint">
              忘记密码？可在应用中心的「设置」中重新设置，或 SSH 登录 NAS 后删除
              <code>/var/apps/libretv/var/password.json</code> 并重启应用。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
