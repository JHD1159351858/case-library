# OCEAN verification — 2026-10-21

Preview: <http://127.0.0.1:1002/ocean/>

## Latest parallax update

- The original clear photographic treatment is restored. Dual-phase flow, artificial normal-based reflections, broad meniscus blur, and the horizontal underwater reveal mask are removed.
- Sky, foreground sea, underwater ceiling and HTML copy now move at different rates. Before entry, projection is anchored at the horizon so the foreground does not form a cutout edge against the sky.
- Entry uses a short full-frame optical blend over progress 0.40–0.58. This removes the page-wipe effect, but remains a transition between two photographs; it is not a continuous simulated camera crossing a three-dimensional water surface.
- At the current 736×940 preview, native wheel input reached progress 0.300 with copy offset -15.515 px, then 0.480 with -24.819 px. Exploration reached 1.000 with -51.7 px; reverse wheel input returned to 0.300. WebGL initialized and no console errors were captured. JavaScript syntax checks pass.
- Evidence: `seam-fix/parallax/surface.png`, `approach.png`, `entry.png`, `underwater.png`, and `checks.json`. The renderer before this update is retained in `seam-fix/renderer-before-parallax.js`.
- The wave amplitude parameter is normalized from 32 CSS pixels and applied to photographic UV displacement. It is not geometric wave height. Real continuously forming wave crests require video frames or a genuinely deforming three-dimensional water surface.

## Initial implementation checks (before the parallax update)

- `node --check` passes for `ocean.js` and `ocean-scene.js`.
- The page, JavaScript, CSS, both backgrounds and local fonts return HTTP 200. WebGL initializes successfully in the browser; no console errors were captured.
- Desktop rendering checked at 1440×810. The supplied screenshots were used for visual comparison; the reference video was played in the browser and the surface, crossing and underwater phases were inspected.
- A native wheel input of 972 px produced scroll position 972 and depth 0.500, with the refracting waterline across the frame. Further scrolling/explore reaches depth 1.000. Reverse scrolling and the surface link restore the surface.
- Ambient sea motion continues while the page remains at depth 0.000. Two screenshots at different times were compared with no scroll or pointer movement. In a 1,240×160 sea sample, 156,894 of 198,400 pixels changed by more than 8 RGB levels; mean channel difference was 23.301. A separate sky sample was unchanged. After pausing, both samples were identical across two captures. Numerical results: `motion-check.json`.
- Pause/resume updates the button's state and visibly freezes/resumes the sea.
- Mobile checked at 393×852: no horizontal overflow, readable overlay, working menu, exploration button reaches depth 1.000, and the return control reaches depth 0.000.
- The cinematic view opens, pauses and closes, restoring the page overlay and previous position.
- Emulated `prefers-reduced-motion: reduce` sets ambient animation to paused. The return control reaches the surface without smooth scrolling.

## Evidence

| State | Screenshot |
| --- | --- |
| Desktop surface | `screenshots/desktop-surface.png` |
| Camera crossing the waterline | `screenshots/desktop-crossing.png` |
| Desktop underwater | `screenshots/desktop-underwater.png` |
| Mobile surface | `screenshots/mobile-surface.png` |
| Mobile underwater | `screenshots/mobile-underwater.png` |
| Time-separated sea animation samples | `screenshots/motion-a.png`, `screenshots/motion-b.png` |
| Time-separated paused samples | `screenshots/paused-a.png`, `screenshots/paused-b.png` |

## Boundaries

- This is a photographic WebGL approximation of the supplied visual references, not the original video, source code, or full fluid simulation. Exact wave shapes and camera optics differ from the source video.
- The original site's secondary pages and film were not supplied. Story and journal controls disclose that missing content; the film control runs an independently authored local ocean study.
- Mobile layout is inferred. Real phone hardware and native touch gestures were not verified: this in-app browser rejected `Input.dispatchTouchEvent`. Mobile layout, menu and scroll-based controls were verified through browser emulation. Native document scrolling is used without a custom touch handler.
- Photographic fallback is present in the code; forced WebGL-unavailable behavior was not browser-tested.
- No production deployment or backend integration was requested or performed. Existing homepage, administration pages and shared styles were left untouched.
- There is no compilation step for this static page. Syntax checks and HTTP/browser verification are the applicable production checks.

The preview process is intentionally retained for the open user-facing page. Temporary source/asset tabs and device/media emulation overrides are cleared after verification.
