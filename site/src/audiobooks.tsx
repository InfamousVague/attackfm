import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The same three stylesheets the app and the home page boot, in the same order.
import '@glacier/tokens/css/fonts.css';
import '@glacier/tokens/css/tokens.css';
import '@glacier/react/styles.css';

import './styles/site.css';
import { Audiobooks } from './pages/Audiobooks.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Audiobooks />
  </StrictMode>,
);
