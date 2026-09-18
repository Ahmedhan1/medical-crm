import { describe, expect, it } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { I18nProvider, useI18n, registerMessages } from './I18nContext.js';

function Probe() {
  const { t, dir, locale, toggleLocale } = useI18n();
  return (
    <div>
      <span data-testid="dir">{dir}</span>
      <span data-testid="locale">{locale}</span>
      <span data-testid="name">{t('app.name')}</span>
      <span data-testid="custom">{t('demo.hello')}</span>
      <button onClick={toggleLocale}>toggle</button>
    </div>
  );
}

describe('i18n + RTL', () => {
  it('defaults to English/LTR and sets <html dir/lang>', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('dir').textContent).toBe('ltr');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(screen.getByTestId('name').textContent).toBe('MEDCORE');
  });

  it('toggles to Arabic and flips direction to RTL structurally', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    act(() => {
      screen.getByText('toggle').click();
    });
    expect(screen.getByTestId('locale').textContent).toBe('ar');
    expect(screen.getByTestId('dir').textContent).toBe('rtl');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(screen.getByTestId('name').textContent).toBe('مِدكور');
  });

  it('lets a domain register its own namespaced messages', () => {
    registerMessages('en', { 'demo.hello': 'Hello domain' });
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('custom').textContent).toBe('Hello domain');
  });
});
