# OCEAN

Independent recreation of the two supplied website screenshots, with an animated ocean and a reversible, scroll-driven descent.

A separate WebGPU FFT version is available at `/ocean/real/`, combining a reference-derived sky-only image with code-generated waves and underwater lighting. See [its README](real/README.md) for rendering details and browser requirements. The original photo-based version remains at `/ocean/`.

## Run locally

From any PowerShell directory:

```powershell
python -m http.server 1002 --bind 127.0.0.1 --directory "D:\Crow5\Project\agent-official-website\project\frontend"
```

Open <http://127.0.0.1:1002/ocean/>. This is buildless HTML, CSS and JavaScript; no npm installation or framework build is needed. Use HTTP instead of opening `index.html` as a `file:` URL because the scene uses ES modules and local textures.

The existing project backend can also serve `/ocean/` without configuration changes. All ocean assets are local. No API calls, login, database, or external runtime dependencies are required.

## Controls

- The waves and sunset reflections move continuously without scrolling.
- Scroll down to approach the sea, pass through a short optical transition and descend. Scroll up to resurface. Sky, foreground sea, underwater ceiling and HTML copy use different scroll rates.
- “Explore the ocean”, “Explore now”, and “Discover” move along the same scroll timeline.
- The bottom-left control freezes or resumes ambient water motion. Scroll navigation remains available while paused.
- The bottom-right control returns to the surface after submerging.
- “Watch the film” opens a 20-second, browser-rendered ocean study. It can be paused, closed, or interrupted with the mouse wheel. This is a local animation, not the reference author's film.
- The mobile menu expands and collapses. `prefers-reduced-motion` starts with ambient animation paused and removes smooth scrolling.

## Reference → local mapping

| Reference | Local destination |
| --- | --- |
| Sunset sea screenshot | `/ocean/`, scroll progress 0 |
| Underwater screenshot | `/ocean/`, scroll progress 1 |
| Supplied motion reference | <https://www.douyin.com/video/7688898157900907987> |
| Our story / Journal labels | Small disclosure panels; original page content was not supplied |

The gray screenshot borders and the bottom white OS gesture indicator are excluded from the webpage. The desktop composition follows the supplied 16:9 view. Mobile layout is inferred because no mobile reference was supplied.

## Files

- `index.html`: real HTML overlay, navigation and dialogs.
- `ocean.css`: isolated typography, layout and mobile styles.
- `ocean.js`: native scroll progress, animation timing, pause and cinematic controls.
- `ocean-scene.js`: dependency-free WebGL water renderer.
- `assets/surface.jpg`, `assets/underwater.jpg`: cleaned photographic backgrounds.
- `assets/fonts/`: bundled Bodoni Moda and DM Sans, with SIL Open Font License files.

## Asset provenance and limits

The two backgrounds were edited from the supplied screenshots with the built-in `imagegen` tool. The original screenshots were not used as a flat page implementation: all text and controls are HTML.

Prompt: Remove all website text, logo, navigation, controls, gray side borders and white gesture indicator. Naturally reconstruct the missing ocean and sky. Preserve the original composition, approximately 67% horizon height, right-hand sunset, realistic water detail and matching underwater sunlight. Do not add text, people, boats or other subjects.

Fonts were downloaded from the official Google Fonts CDN; the accompanying licenses are from the Google Fonts repository. They are visual substitutes because the original website font files were not supplied.

The current ocean uses photographic textures, depth-dependent projection, periodic texture displacement and a brief optical blend into the underwater photograph. It has no deforming 3D ocean mesh. This restores clear imagery and adds parallax, but does not create physically evolving wave geometry or a genuinely continuous camera crossing. The supplied Douyin video is a motion reference, and has not been embedded or redistributed. Real continuously forming crests would require a continuous video or replacement with a real-time 3D water renderer. Unsupported WebGL falls back to photographic layers while preserving scroll navigation.

Verification evidence is in `doc/ocean-clone/` at the project root.
