import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./lib/amplify"; // Initialize Amplify

import { warn, debug, trace, info, error } from '@tauri-apps/plugin-log';
import { isTauri } from '@tauri-apps/api/core';
import { installContextMenuGuard } from './lib/touch';

function forwardConsole(
  fnName: 'log' | 'debug' | 'info' | 'warn' | 'error',
  logger: (message: string) => Promise<void>
) {
  const original = console[fnName];
  console[fnName] = (message, ...optionalParams) => {
    original(message, ...optionalParams);
    
    // Format message with optional params for the Tauri logger
    const formattedMessage = typeof message === 'string' 
      ? [message, ...optionalParams].join(' ')
      : [JSON.stringify(message), ...optionalParams.map(p => typeof p === 'string' ? p : JSON.stringify(p))].join(' ');
      
    logger(formattedMessage).catch(console.error);
  };
}

// Forward frontend logs to Tauri plugin so they save to the same file
if (isTauri()) {
  forwardConsole('log', trace);
  forwardConsole('debug', debug);
  forwardConsole('info', info);
  forwardConsole('warn', warn);
  forwardConsole('error', error);
  // Android WebView opens its own long-press menu regardless of the CSS opt-out;
  // the shell cancels it except over editable fields.
  installContextMenuGuard();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
