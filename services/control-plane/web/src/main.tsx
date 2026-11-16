import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import './index.css';
import { Layout } from './components/Layout.tsx';
import { AppLayout } from './pages/AppLayout.tsx';
import { AppsPage } from './pages/Apps.tsx';
import { LoginPage } from './pages/Login.tsx';

/** Route modules load on demand so the charting library isn't in the first bundle. */
const page =
  <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  async () => ({ Component: (await load())[name] });

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <AppsPage /> },
      { path: 'admin', lazy: page(() => import('./pages/Admin.tsx'), 'AdminPage') },
      {
        path: 'apps/:app',
        element: <AppLayout />,
        children: [
          { index: true, lazy: page(() => import('./pages/app/Overview.tsx'), 'OverviewTab') },
          { path: 'requests', lazy: page(() => import('./pages/app/Requests.tsx'), 'RequestsTab') },
          { path: 'logs', lazy: page(() => import('./pages/app/Logs.tsx'), 'LogsTab') },
          { path: 'traces', lazy: page(() => import('./pages/app/Traces.tsx'), 'TracesTab') },
          { path: 'traces/:trace', lazy: page(() => import('./pages/app/Traces.tsx'), 'TracesTab') },
          { path: 'errors', lazy: page(() => import('./pages/app/Errors.tsx'), 'ErrorsTab') },
          { path: 'jobs', lazy: page(() => import('./pages/app/Jobs.tsx'), 'JobsTab') },
          { path: 'email', lazy: page(() => import('./pages/app/Email.tsx'), 'EmailTab') },
          { path: 'services', lazy: page(() => import('./pages/app/Services.tsx'), 'ServicesTab') },
          { path: 'data', lazy: page(() => import('./pages/app/Data.tsx'), 'DataTab') },
          { path: 'deployments', lazy: page(() => import('./pages/app/Deployments.tsx'), 'DeploymentsTab') },
          { path: 'secrets', lazy: page(() => import('./pages/app/Secrets.tsx'), 'SecretsTab') },
          { path: 'cost', lazy: page(() => import('./pages/app/Cost.tsx'), 'CostTab') },
          { path: 'settings', lazy: page(() => import('./pages/app/Settings.tsx'), 'SettingsTab') },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
