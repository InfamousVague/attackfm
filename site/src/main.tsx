import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The same three stylesheets the app boots, in the same order, so the site and
// the product share one palette, one type ramp, and one component surface.
import '@glacier/tokens/css/fonts.css';
import '@glacier/tokens/css/tokens.css';
import '@glacier/react/styles.css';

import './styles/site.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
