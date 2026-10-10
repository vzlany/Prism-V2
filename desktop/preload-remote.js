'use strict';

// The minimal bridge for a REMOTE device window (the server's web UI shown in the app): no
// desktop powers, just the way back — the page's device menu offers "This PC", which asks
// the main process to close this window and show the local one again.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openghostRemote', {
 back: () => ipcRenderer.invoke('devices:back'),
});
