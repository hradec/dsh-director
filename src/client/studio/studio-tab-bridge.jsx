import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {FootageBoard} from './FootageBoard.jsx';

// The Timeline dock runs in a separate realm (the panel host's own document,
// which the harness puts in an iframe). The Studio Footage/Images boards are
// client (React-18) components, so to show them INSIDE the dock we install the
// bridge onto the HOST window (same-origin) just before mounting the engine —
// the engine's StudioLibraryPanel then finds window.__DSH_STUDIO_TABS__ in its
// own realm. Roots render here in the client realm into the given host element;
// React attaches listeners to that element's ownerDocument, so the iframe's
// document is the right scope.
// Mount FootageBoard DIRECTLY (not the StudioTab wrapper): StudioTab nests a
// further srcdoc iframe, which put the cards two documents away from the dock
// — the drag bridge and the lane preview both need one shared document.
export function installStudioTabBridge(win){
  if(!win||win.__DSH_STUDIO_TABS__)return;
  const roots=new Map();
  win.__DSH_STUDIO_TABS__={
    mount(kind,el){
      if(roots.has(el))return;
      if(!el||(kind!=='footage'&&kind!=='images'))return;
      const root=createRoot(el);
      roots.set(el,root);
      root.render(React.createElement(FootageBoard,{lib:kind}));
    },
    unmount(el){const r=roots.get(el);if(r){roots.delete(el);r.unmount();}},
  };
}
