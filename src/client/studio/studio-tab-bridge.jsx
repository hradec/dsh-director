import * as React from 'react';
import {createRoot} from 'react-dom/client';
import {FootageTab,ImagesTab} from './StudioSidebar.jsx';
import {askDshAgent} from './agent-queue.jsx';

// The Timeline dock runs in a separate realm (the panel host's own document,
// which the harness puts in an iframe). The Studio Footage/Images tabs are
// client (React-18) components, so to show them INSIDE the dock we install the
// bridge onto the HOST window (same-origin) just before mounting the engine —
// the engine's StudioLibraryPanel then finds window.__DSH_STUDIO_TABS__ in its
// own realm. Roots render here in the client realm into the given host element;
// React attaches listeners to that element's ownerDocument, so the iframe's
// document is the right scope.
export function installStudioTabBridge(win){
  if(!win||win.__DSH_STUDIO_TABS__)return;
  const roots=new Map();
  win.__DSH_STUDIO_TABS__={
    mount(kind,el,opts={}){
      if(roots.has(el))return;
      const Body=kind==='footage'?FootageTab:kind==='images'?ImagesTab:null;
      if(!Body||!el)return;
      const root=createRoot(el);
      roots.set(el,root);
      const session=opts.sessionId??win.__DSH_DIRECTOR_SESSION__??'';
      root.render(React.createElement(Body,{sessionId:session,sendDshRequest:(text,label)=>askDshAgent(text,label)}));
    },
    unmount(el){const r=roots.get(el);if(r){roots.delete(el);r.unmount();}},
  };
}
