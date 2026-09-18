import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { Spinner } from '../ui/index.js';

/**
 * Route guard. An unauthenticated user is sent to /login (fail closed). These are
 * UX controls: the backend re-checks auth on every request, so a forged client
 * state cannot access data.
 */
export function ProtectedRoute(): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spinner label="Loading" />
      </div>
    );
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

/**
 * Permission-aware rendering. Shows children only if the principal holds the
 * permission; otherwise renders `fallback` (default: nothing). This hides UI a
 * user cannot use — it is NOT a security boundary (the backend enforces authz).
 */
export function PermissionGate({
  permission,
  anyOf,
  fallback = null,
  children,
}: {
  permission?: string;
  anyOf?: string[];
  fallback?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const { can } = useAuth();
  const allowed = permission ? can(permission) : anyOf ? anyOf.some((p) => can(p)) : true;
  return <>{allowed ? children : fallback}</>;
}
