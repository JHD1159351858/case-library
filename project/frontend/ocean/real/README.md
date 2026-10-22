# OCEAN: reference sky and FFT ocean

Open http://127.0.0.1:1002/ocean/real/ with a WebGPU-capable browser. The same local HTTP server serves both this version and the previous `/ocean/` version. No build or package installation is needed.

For the integrated agent platform, use http://127.0.0.1:2001/. Its default homepage remains the particle version. Both homepages provide a “首页风格” selector linking `/` (particles) and `/ocean/real/` (ocean), with the current choice marked. These are ordinary same-origin links, with no automatic redirect or stored preference. `/agents.html` continues to use the existing platform backend and session. Port 1002 remains a static-only preview.

This route combines a sky-only reference image with code-generated moving waves, foam, reflections and underwater light. The sky contains no sea or interface text. The HTML overlay presents the agent case platform. The separate older `/ocean/` route still contains the earlier full photographic experiment.

## Rendering

- Six 256 x 256 spectral cascades, JONSWAP wind sea plus swell, GPU inverse FFT and horizontal crest displacement.
- A camera-centred CDLOD ocean grid, from nearby geometric waves to the horizon; fine slopes use filtered moments to control specular aliasing.
- `assets/sky-reference.png` supplies the visible sky and the water's environment reflections through a shared world-direction projection. A one-time inverse tone-map preserves the photograph's colours in the existing HDR pipeline. Beyond the image's angular coverage, a smooth blend extends the sky with the existing procedural atmosphere and clouds.
- Atmospheric scattering LUTs continue to supply underwater ambient illumination. The sky image is static; moving water geometry changes its reflection continuously.
- Scroll moves one camera from 2.4 m above mean sea level to 7 m below it. It follows the local swell on approach and tilts upward before entering. Real FFT geometry supplies both sides of the water surface; immersion is evaluated at the same near plane used for clipping.
- Underwater rendering uses refracted sky light, rough dielectric Fresnel reflection, depth-dependent blue scattering and ray-integrated moving sunlight. Near-view immersion follows the live FFT height and slope. The entire scene shares one HDR exposure and tone map, with no image crossfade or separate underwater colour pipeline.
- The page's external animation clock controls simulation time, pause and tab visibility. No second animation loop or mouse capture is installed.
- A full-screen ripple loader keeps the homepage inactive until textures and shaders are ready and the first ocean frame has completed on the GPU. After the canvas reaches a paint, the loader fades out. Startup failure shows retry and case-library links; there is no fabricated percentage or fixed waiting period.

## Provenance

`vendor/` is adapted editable source from [Noniv/web-ocean](https://github.com/Noniv/web-ocean), retrieved 2026-10-22. Copyright (c) 2026 Maksymilian Dendura; the original MIT license is retained in `vendor/LICENSE`.

Local adaptations provide the scroll camera, lifecycle integration, reference sky, underwater rendering and art direction. The sky image was edited using the built-in imagegen tool from the existing cleaned `assets/surface.jpg`, itself derived from the user's reference. Prompt and asset details: `assets/sky-reference.md`. Upstream logging/screenshot network endpoints are removed. This is not the reference video's source code.

## Limits

This is a real-time spectral surface with approximate lighting, not a full volumetric fluid solver. It does not simulate overturning waves or physical spray. The underwater destination is open water, with no seafloor geometry. The sky is an edited reference plate rather than a fully spherical HDR capture or animated cloud simulation. This implementation does not claim pixel-identical photographic realism. WebGPU is required; unsupported devices receive a readable status. Mobile GPU performance depends on hardware.

Latest sky integration verification: `doc/ocean-clone/fft-preview/sky-reference-verification.md` at the repository root. The earlier pure-code baseline remains documented in `procedural-verification.md`.
