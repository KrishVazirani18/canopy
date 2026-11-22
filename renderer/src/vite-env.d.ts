/// <reference types="vite/client" />

// The widget frame's page, bundled to one script (see canopyFrame in vite.config.ts).
declare module 'virtual:canopy-frame' {
  const js: string;
  export default js;
}
