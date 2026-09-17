import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth/AuthContext.js';
import { useI18n } from '../lib/i18n/I18nContext.js';
import { ApiError } from '../lib/api/types.js';
import { Alert, Button, Card, Input } from '../components/ui/index.js';

/** Public sign-in page. On success, routes to the originally requested page. */
export function LoginPage(): JSX.Element {
  const { t, toggleLocale } = useI18n();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [clinicId, setClinicId] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(clinicId.trim(), username.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      // Never echo raw server internals; a generic, enumeration-safe message.
      setError(err instanceof ApiError ? t('auth.failed') : t('auth.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mc-auth-layout">
      <div className="mc-auth-card">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBlockEnd: 8 }}>
          <Button variant="ghost" onClick={toggleLocale}>
            {t('lang.toggle')}
          </Button>
        </div>
        <Card title={t('auth.signIn')}>
          <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {error && (
              <Alert tone="danger" role="alert">
                {error}
              </Alert>
            )}
            <Input
              label={t('auth.clinicId')}
              value={clinicId}
              onChange={(e) => setClinicId(e.target.value)}
              autoComplete="off"
              required
            />
            <Input
              label={t('auth.username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
            <Input
              label={t('auth.password')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <Button type="submit" loading={busy}>
              {busy ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
