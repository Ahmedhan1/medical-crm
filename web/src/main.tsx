import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { AuthProvider } from './lib/auth/AuthContext.js';
import { I18nProvider } from './lib/i18n/I18nContext.js';
import { ToastProvider } from './components/ui/index.js';
import './styles/tokens.css';
import './styles/global.css';

// --- Domain registration block (one coordinated side-effect import per domain;
// see docs/platform/FRONTEND-INTEGRATION.md). Each domain self-registers its nav,
// routes and i18n via the platform extension points — no other shared-file edits.
import './domains/clinical/register.js'; // CCR-015 (Agent 2 clinical UX)
import './domains/ai/register.js';         // Agent 3 — review-first AI UX
import './domains/automation/register.js'; // Agent 3 — automation engine UX
import './domains/messaging/register.js';  // Agent 3 — WhatsApp setup + consent
import './domains/inventory/register.js';  // Agent 3 — inventory / stock control
import './domains/pharma/register.js';     // Agent 3 — pharma (drug master, content, reporting)
import './domains/crm/register.js';        // Agent 3 — CRM (HCP/HCO, visits)

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </I18nProvider>
  </StrictMode>,
);
