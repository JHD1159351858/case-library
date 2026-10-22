# Hybrid background update — 2026-10-22

- Route: http://127.0.0.1:1002/ocean/real/
- Reused the existing text-free `surface.jpg` and `underwater.jpg` assets without editing their files. Sky sampling excludes the source's photographed sea.
- Retained FFT geometry, foam, pause clock, height probe and continuous scroll camera. Sky reflections now sample the reference sky; underwater photographs use projection plus live normal distortion.
- Seven vendor JavaScript modules passed syntax checks. The live WebGPU shaders compiled and rendered with no captured console warnings/errors.
- Verified both ends of the journey and reverse mouse-wheel input at progress .363, with the camera near mean sea level and a visible geometric wave silhouette.
- Two captures while submerged at progress 1 differed in 57.79% of pixels by more than 3 RGB levels, confirming continued movement. This is photographic detail deformation, not a fully simulated underwater volume.
- Final screenshots: `hybrid-surface.png`, `hybrid-underwater-a.png`. Motion comparison: `hybrid-underwater-b.png`.

The earlier `verification.md` records the initial fully procedural version and does not describe the current photographic backgrounds.
