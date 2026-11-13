import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import '@fontsource-variable/inter/index.css';
import './appearance.css';
import { createScreenApplication } from './screen-application';
const screenApplication = createScreenApplication();
window.addEventListener('pagehide', () => screenApplication.runtime.suspend());
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App screenApplication={screenApplication} />
  </React.StrictMode>,
);
