import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, apiRequest, configureApiClient } from '../api/client.js';
import { TOKEN_STORAGE_KEY } from '../config.js';

/** The authenticated principal, mirrored from the backend `/auth/me` contract. */
export interface AuthUser {
  id: string;
  username: string;
  clinicId: string;
  roles: string[];
  permissions: string[];
}

interface LoginResponse {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  user: AuthUser | null;
  login: (clinicId: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** True if the principal holds the permission. UX control ONLY — backend is authoritative. */
  can: (permission: string) => boolean;
  hasRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* private mode / storage blocked — session simply won't persist */
  }
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const tokenRef = useRef<string | null>(readToken());
  const [status, setStatus] = useState<Status>(tokenRef.current ? 'loading' : 'anonymous');
  const [user, setUser] = useState<AuthUser | null>(null);

  const clearSession = useCallback(() => {
    tokenRef.current = null;
    writeToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  // Wire the API client to this session exactly once. 401 from any call fails
  // closed here → back to the login screen.
  useEffect(() => {
    configureApiClient({
      tokenProvider: () => tokenRef.current,
      onUnauthorized: () => clearSession(),
    });
  }, [clearSession]);

  // Resume an existing session on load by validating the token against /auth/me.
  useEffect(() => {
    if (!tokenRef.current) return;
    let cancelled = false;
    apiRequest<AuthUser>('/auth/me')
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      })
      .catch(() => {
        if (!cancelled) clearSession();
      });
    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  const login = useCallback(
    async (clinicId: string, username: string, password: string) => {
      const res = await api.post<LoginResponse>('/auth/login', { clinicId, username, password });
      tokenRef.current = res.token;
      writeToken(res.token);
      setUser(res.user);
      setStatus('authenticated');
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* best-effort server revoke; clear locally regardless */
    }
    clearSession();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(() => {
    const perms = new Set(user?.permissions ?? []);
    const roles = new Set(user?.roles ?? []);
    return {
      status,
      user,
      login,
      logout,
      can: (permission: string) => perms.has(permission),
      hasRole: (role: string) => roles.has(role),
    };
  }, [status, user, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
