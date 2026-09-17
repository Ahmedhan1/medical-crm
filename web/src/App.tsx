import { createElement } from 'react';
import { Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './components/auth/guards.js';
import { AppShell } from './components/layout/AppShell.js';
import { useAuth } from './lib/auth/AuthContext.js';
import { getRoutes } from './lib/nav/registry.js';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage, ForbiddenPage, NotFoundPage } from './pages/system.js';

// Registered platform nav (side-effect import). Domain modules add their own
// `import './clinical/register'` etc. in their entry so their routes/nav appear.
import './platform-nav.js';

/** Wraps a registered domain route so it 403s (not crashes) without permission. */
function GuardedRoute({
  permission,
  component,
}: {
  permission?: string;
  component: React.ComponentType;
}): JSX.Element {
  const { can } = useAuth();
  if (permission && !can(permission)) return <ForbiddenPage />;
  return createElement(component);
}

export function App(): JSX.Element {
  const domainRoutes = getRoutes();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="/forbidden" element={<ForbiddenPage />} />
          {domainRoutes.map((r) => (
            <Route
              key={r.path}
              path={r.path}
              element={<GuardedRoute permission={r.permission} component={r.component} />}
            />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
