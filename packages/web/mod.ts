/**
 * `@tykotech/web` — the live-view SPA.
 *
 * Framework-free; bundled by `deno task build:web` into `dist/app.js` plus the
 * lazily loaded chunks it imports, all served as static assets by the gateway.
 * The entry module (`src/app.ts`) has side effects (it mounts the router), so it
 * is not re-exported here.
 */
export { type CanvasSurface, createCanvas } from './src/canvas.ts';
export { type LiveViewEvents, LiveViewSocket } from './src/ws.ts';
export { api, ApiError, clearSession, isSignedIn, restoreSession, setSession } from './src/api.ts';
export { renderA2uiSurface } from './src/a2ui.ts';
