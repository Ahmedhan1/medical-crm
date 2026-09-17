/**
 * Runtime config. The API is reached at a same-origin base path so there is no
 * CORS surface and no backend CORS config is required: in dev Vite proxies
 * `/api` → the backend; in production the BOX serves the SPA and the API behind
 * one origin. Override with `VITE_API_BASE` only for non-standard deployments.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

/** Local-storage key for the opaque session token (no PHI; a bearer token only). */
export const TOKEN_STORAGE_KEY = 'medcore.session.token';

/** Local-storage key for the UI locale preference (not PHI). */
export const LOCALE_STORAGE_KEY = 'medcore.locale';
