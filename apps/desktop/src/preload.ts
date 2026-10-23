import { contextBridge } from 'electron';
contextBridge.exposeInMainWorld(
  'tricordDesktop',
  Object.freeze({ platform: process.platform, version: '0.1.0' }),
);
