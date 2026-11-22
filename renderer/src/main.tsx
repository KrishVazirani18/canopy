import { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ErrorBoundary } from './components/canopy/error-boundary';
import { installRichReplies } from './lib/rich-reply';
import { TourOverlay } from './components/canopy/first-run/tour';

installRichReplies();

// The Playground is a design tool: its code is fetched only when a source run asks for it.
const BareMock = lazy(() => import('./playground/playground').then((m) => ({ default: m.BareMock })));

// No StrictMode: it double-runs effects in dev, which double-starts things like the terminal view.
// From source only (a packaged Canopy ignores it):
// ?mock=<id> shows one Playground mock on its own, filling the window (for looking at a design as it would ship);
// ?mock=tour runs the product tour over the app itself; ?mock=onboarding runs the first run over the app (App shows it), whatever main says.
const bare = window.canopy?.dev ? new URLSearchParams(location.search).get('mock') : null;
createRoot(document.getElementById('root')!).render(<ErrorBoundary>{bare === 'tour' ? <><App /><TourOverlay /></> : bare === 'onboarding' ? <App /> : bare ? <Suspense fallback={null}><BareMock id={bare} /></Suspense> : <App />}</ErrorBoundary>);
