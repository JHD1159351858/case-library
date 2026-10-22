# OCEAN screenshot clone

## Scope and route

The two supplied screenshots are the approved visual references: the sunset ocean surface and the view immediately below the surface. Add `/ocean/` at `project/frontend/ocean/index.html`; preserve all existing pages and server behavior. Interpret downward mouse scrolling as descent and upward scrolling as resurfacing. No original URL, video, mobile reference, or secondary-page content was supplied.

## Implementation

1. Rebuild the overlay as real HTML and scoped CSS, with a two-line editorial heading, top navigation, action buttons, and bottom controls. Download and bundle open fonts. Match the reference at a 16:9 viewport; adapt the layout for touch screens.
2. Clean the supplied backgrounds with the built-in image generator, retaining the reference composition. Render them with a small dependency-free WebGL shader: moving surface refraction and highlights, a scroll-driven waterline, underwater refraction and particles. Use native document scrolling, keep the scene fixed, and support reverse scrolling. Keep photographic fallback layers.
3. Provide pause, a reduced-motion mode, jump-to-explore controls, and a local cinematic journey for the film action. Secondary navigation must clearly disclose unavailable reference content rather than inventing source pages.

## File ownership

- Main agent: `index.html`, `ocean.css`, `ocean.js`, local fonts, documentation and browser verification.
- Renderer agent: `ocean-scene.js` only.
- Asset agent: `assets/surface.jpg`, `assets/underwater.jpg` only.

## Verification

- Check JavaScript syntax and local HTTP asset responses; no framework compilation is required for this buildless page.
- Visually compare desktop surface and underwater states with the supplied references.
- Exercise actual wheel descent and ascent, pause/resume, explore buttons, cinematic close/restore, and mobile touch scrolling.
- Check mobile horizontal overflow, reduced-motion behavior, console/runtime errors, and fallback behavior.

## Known evidence boundary

Backgrounds are regenerated from screenshots. Motion is an independently implemented photographic WebGL treatment, not recovered original video or 3D source. Secondary-page content and exact original fonts/interactions are unavailable. The screenshot's gray outer frame and bottom white OS gesture indicator are excluded from the website.
