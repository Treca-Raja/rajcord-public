import './app/styles';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { FeatureBoundary } from './shared/FeatureBoundary';
import { createScreenApplication } from './features/screen-sharing/composition';
const screenApplication = createScreenApplication();
window.addEventListener('pagehide', () => screenApplication.runtime.suspend());
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FeatureBoundary name="Rajcord">
      <App screenApplication={screenApplication} />
    </FeatureBoundary>
  </React.StrictMode>,
);
