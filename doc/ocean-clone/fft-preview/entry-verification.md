# Underwater transition correction — 2026-10-22

The accepted sky, surface-wave parameters, above-water shading and scroll camera path are retained.

The original hybrid version switched every visible mesh fragment to the underwater photograph when one camera-height value crossed zero. Its fixed 38-degree photo projection also sampled beyond the image at the initial 9.5-degree viewing angle, stretching the final row and sliding the image into view as the camera tilted.

The correction uses the mesh's actual front/back orientation, the live height-probe tangent for the near-view waterline, a photo projection that mostly follows the viewing angle, and broad-wave-only optical displacement. The reference environment enters gradually with immersion instead of immediately replacing the water material. The underwater ceiling converges to the same background colour at long distance and grazing viewing angles.

Validation: four changed JavaScript modules passed syntax checks; live WebGPU compilation and rendering were exercised at the entry region and fully submerged, followed by a return to the surface. A stale browser module cache was found during testing and refreshed; normal caching was restored. Existing above-water tone-map calculations are reused unchanged through an extracted shader snippet.

This remains a hybrid renderer: the photo details are optically deformed, and the underlying wave geometry is simulated. Naturalness was checked visually, not established as physical ground truth.
