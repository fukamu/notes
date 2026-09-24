import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import '@/app/globals.css';
import { RouteApplication } from './routes';

const root = document.getElementById('root');
if (!root) throw new Error('Static frontend root is missing');

hydrateRoot(
  root,
  <StrictMode>
    <RouteApplication pathname={window.location.pathname} />
  </StrictMode>,
);
