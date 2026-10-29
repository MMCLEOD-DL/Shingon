import { useCallback, useEffect, useState } from 'react';
import { ApiError, bootstrapFromFragment } from './api.js';
import { ErrorNote } from './components/ErrorNote.jsx';
import { Setup } from './views/Setup.jsx';
import { NewTask } from './views/NewTask.jsx';
import { RunView } from './views/RunView.jsx';
import { History } from './views/History.jsx';

const VIEWS = [
  { path: '/', label: 'New task' },
  { path: '/history', label: 'History' },
  { path: '/setup', label: 'Connections' },
];

function route(pathname) {
  const run = /^\/runs\/([\w-]{1,80})$/.exec(pathname);
  if (run) return { view: 'run', runId: run[1] };
  if (pathname === '/history') return { view: 'history' };
  if (pathname === '/setup') return { view: 'setup' };
  return { view: 'new' };
}

export function App({ api }) {
  const [session, setSession] = useState('checking'); // checking | ready | signed-out
  const [signInError, setSignInError] = useState(null);
  const [location, setLocation] = useState(() => route(window.location.pathname));

  const go = useCallback((path) => {
    window.history.pushState(null, '', path);
    setLocation(route(path));
  }, []);

  useEffect(() => {
    const onPop = () => setLocation(route(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await bootstrapFromFragment(api);
        await api.health();
        if (!cancelled) setSession('ready');
      } catch (e) {
        if (cancelled) return;
        setSignInError(e);
        setSession(e instanceof ApiError && e.status === 401 ? 'signed-out' : 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  if (session === 'checking') return <main className="shell"><p role="status">Connecting to the local Conductor service…</p></main>;
  if (session !== 'ready') {
    return (
      <main className="shell">
        <h1>Conductor</h1>
        {session === 'signed-out' ? (
          <section className="panel">
            <h2>Sign in with the app's link</h2>
            <p>Open the link the Conductor app printed when it started (it contains <code>#bootstrap=</code>). A link works once and for five minutes. If it has expired or was already used, stop the app and start it again for a new link.</p>
            <ErrorNote error={signInError} />
          </section>
        ) : <ErrorNote error={signInError} />}
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">Conductor</span>
        <nav aria-label="Main">
          {VIEWS.map((v) => (
            <a key={v.path} href={v.path} aria-current={route(v.path).view === location.view ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); go(v.path); }}>{v.label}</a>
          ))}
        </nav>
      </header>
      <main>
        {location.view === 'new' && <NewTask api={api} go={go} />}
        {location.view === 'history' && <History api={api} go={go} />}
        {location.view === 'setup' && <Setup api={api} />}
        {location.view === 'run' && <RunView key={location.runId} api={api} runId={location.runId} go={go} />}
      </main>
    </div>
  );
}
