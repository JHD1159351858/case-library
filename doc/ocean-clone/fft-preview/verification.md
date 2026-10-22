# Procedural ocean preview — 2026-10-22

Local route: http://127.0.0.1:1002/ocean/real/

## Verified

- Seven JavaScript modules passed `node --check`. WGSL compilation was also checked by the live WebGPU device; the final browser load reported no warnings or errors.
- The canvas reported `webgpu-fft`; the route contains no photograph, video element or external runtime request. Atmosphere, cloud and foam textures are generated on the GPU.
- Real mouse-wheel input moved scroll progress from 0 to .347 and .463. The camera moved from approximately +2.4 m to +.38 m and -1.34 m. The same displaced water mesh appeared above and below the camera.
- The explore control descended to -7 m. The surface link reversed the journey. Surface height continued changing while the camera remained underwater.
- Two underwater running captures changed 78.45% of pixels by more than 3 RGB levels. Two captures after pausing were pixel-identical. Those comparison captures precede the final cloud/Fresnel visual refinement; animation timing was unchanged.
- A 393 x 852 emulated viewport rendered with a 393 x 852 canvas and document scroll width 393. This is a desktop browser viewport check, not physical-phone performance testing. The emulation was cleared afterward.
- The existing `/ocean/` page still reported its original `webgl` renderer and `scene-ready`, without console warnings or errors.

## Visual artifacts

- `surface.png`: final procedural sunset and moving-wave scene.
- `underwater.png`: final underwater view of the same FFT surface.
- `underwater-running-a.png`, `underwater-running-b.png`: motion comparison.
- `paused-a.png`, `paused-b.png`: pause comparison.

The preview is a spectral surface renderer. It does not provide full volumetric breaking waves, spray, seafloor geometry or path-traced underwater light. It requires WebGPU. No external deployment or physical-mobile-device validation was performed.
