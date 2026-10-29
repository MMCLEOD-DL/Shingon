import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { createApi } from './api.js';
import './styles.css';

// There is no simulated transport: if the service is missing, the UI says so instead of pretending.
createRoot(document.getElementById('root')).render(<StrictMode><App api={createApi()} /></StrictMode>);
