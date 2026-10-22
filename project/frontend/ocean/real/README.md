# OCEAN: procedural sky and FFT ocean

Open http://127.0.0.1:1002/ocean/real/ with a WebGPU-capable browser. The same local HTTP server serves both this version and the previous `/ocean/` version. No build or package installation is needed.

This route generates the sky, clouds, moving waves, foam, reflections and underwater light in code. It loads no background photograph or video. The HTML overlay and local fonts are reused. The separate older `/ocean/` route still contains the earlier photographic experiment.

## Rendering

- Six 256 x 256 spectral cascades, JONSWAP wind sea plus swell, GPU inverse FFT and horizontal crest displacement.
- A camera-centred CDLOD ocean grid, from nearby geometric waves to the horizon; fine slopes use filtered moments to control specular aliasing.
- Atmospheric scattering LUTs and two procedural cloud layers. Low clouds integrate density at three heights; density and sunlight samples provide cloud relief. The same sky supplies the water's environment reflections.
- Scroll moves one camera from 2.4 m above mean sea level to 7 m below it. It follows the local swell and descends slowly near the interface, tilting upward before entering. Real FFT geometry supplies both sides of the water surface.
- Underwater rendering uses refracted sky light, rough dielectric Fresnel reflection, depth-dependent blue scattering and ray-integrated moving sunlight. Near-view immersion follows the live FFT height and slope. The entire scene shares one HDR exposure and tone map, with no image crossfade or separate underwater colour pipeline.
- The page's external animation clock controls simulation time, pause and tab visibility. No second animation loop or mouse capture is installed.

## Provenance

`vendor/` is adapted editable source from [Noniv/web-ocean](https://github.com/Noniv/web-ocean), retrieved 2026-10-22. Copyright (c) 2026 Maksymilian Dendura; the original MIT license is retained in `vendor/LICENSE`.

Local adaptations provide the scroll camera, lifecycle integration, procedural cloud changes, underwater rendering and art direction. Upstream logging/screenshot network endpoints are removed. This is not the reference video's source code.

## Limits

This is a real-time spectral surface with approximate lighting, not a full volumetric fluid solver. It does not simulate overturning waves or physical spray. The underwater destination is open water, with no seafloor geometry. Clouds and fine lighting differ from the reference photographs; this implementation does not claim pixel-identical photographic realism. WebGPU is required; unsupported devices receive a readable status. Mobile GPU performance depends on hardware.

Latest verification: `doc/ocean-clone/fft-preview/procedural-verification.md` at the repository root.
