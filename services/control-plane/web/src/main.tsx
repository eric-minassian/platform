import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './app.tsx';
import { router } from './router.tsx';

createRoot(document.getElementById('root')!).render(<App router={router} />);
