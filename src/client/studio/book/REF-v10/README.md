# Director Studio Book UI v10

Open `demo.html` in a browser. The standalone version embeds all assets. No external dependencies.

Both resting pages are built by `buildSurface()` from the same parchment, original responsive frame, edge-aging textures, interior stains and illustrations. `makeFace()` clones the actual resting page surface, then adds a snapshot of the HTML content. Only the 3D transform and lighting are different. The common page contour is traced in reference coordinates and mapped through the 15-slice frame at each resize. This clips both surfaces to the curved leaf instead of laying a hard rectangle across the binding. All previous navigation, resizing, stain and illustration toggles are retained.
