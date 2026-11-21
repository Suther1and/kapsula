import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/onest';
import '@fontsource-variable/jetbrains-mono';
import 'overlayscrollbars/overlayscrollbars.css';
import './styles/tokens.css';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
