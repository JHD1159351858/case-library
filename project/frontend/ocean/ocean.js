const root = document.documentElement;
const stage = document.querySelector('#ocean-stage');
const canvas = document.querySelector('#ocean-canvas');
const pauseButton = document.querySelector('#toggle-motion');
const motionLabel = document.querySelector('#motion-label');
const scrollCue = document.querySelector('#scroll-cue');
const scrollLabel = document.querySelector('#scroll-label');
const menuButton = document.querySelector('.menu-button');
const mobileNavigation = document.querySelector('#mobile-navigation');
const panel = document.querySelector('#reference-dialog');
const film = document.querySelector('#film-dialog');
const filmPause = document.querySelector('.film-pause');
const filmTime = document.querySelector('.film-time');
const filmProgress = document.querySelector('.film-progress > span');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let paused = reducedMotion.matches;
let renderer;
let frame;
let progress = 0;
let target = 0;
let pointer = { x: 0, y: 0 };
let animationTime = 0;
let lastTimestamp = 0;
let lastDraw = 0;
let filmElapsed = 0;
let filmPaused = false;
let savedProgress = 0;
let savedPaused = false;

function scrollRange() {
  return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
}

function closeMenu() {
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Open navigation');
  mobileNavigation.hidden = true;
}

function goToDepth(depth) {
  closeMenu();
  window.scrollTo({ top: depth * scrollRange(), behavior: reducedMotion.matches ? 'instant' : 'smooth' });
}

function updatePause() {
  pauseButton.setAttribute('aria-pressed', String(paused));
  pauseButton.setAttribute('aria-label', paused ? 'Resume ocean animation' : 'Pause ocean animation');
  motionLabel.textContent = paused ? 'A moment of stillness' : 'Live at sea';
}

function updateScrollState() {
  target = Math.max(0, Math.min(1, window.scrollY / scrollRange()));
  if (reducedMotion.matches) progress = target;
  requestFrame();
}

function render(timestamp) {
  frame = undefined;
  const delta = lastTimestamp ? Math.min((timestamp - lastTimestamp) / 1000, 0.05) : 0;
  lastTimestamp = timestamp;
  if (!paused && !document.hidden && (!film.open || !filmPaused)) animationTime += delta;

  if (film.open) {
    if (!filmPaused && !paused) filmElapsed = Math.min(20, filmElapsed + delta);
    const journey = filmElapsed / 20;
    progress = journey < 0.72
      ? Math.pow(Math.sin((journey / 0.72) * Math.PI / 2), 2)
      : 1 - Math.pow(Math.sin(((journey - 0.72) / 0.28) * Math.PI / 2), 2);
    filmProgress.style.transform = `scaleX(${journey})`;
    filmTime.textContent = `00:${String(Math.floor(filmElapsed)).padStart(2, '0')} / 00:20`;
    if (filmElapsed === 20) setFilmPaused(true);
  } else {
    progress += (target - progress) * (1 - Math.exp(-delta * 7.5));
    if (Math.abs(target - progress) < 0.0002) progress = target;
  }

  const immersion = Math.max(0, Math.min(1, (progress - 0.40) / 0.18));
  root.style.setProperty('--dive', (immersion * immersion * (3 - 2 * immersion)).toFixed(4));
  root.style.setProperty('--copy-offset', `${reducedMotion.matches ? 0 : -progress * innerHeight * 0.055}px`);
  stage.dataset.depth = progress.toFixed(3);
  const submerged = renderer?.submerged ?? (progress > 0.62);
  stage.classList.toggle('is-submerged', submerged);
  scrollCue.dataset.depth = submerged ? '0' : '1';
  scrollLabel.textContent = submerged ? 'Scroll to resurface' : 'Scroll to explore';

  // A 30 fps cap keeps the continuous background light on laptops and phones.
  if (renderer && (timestamp - lastDraw >= 1000 / 30 || paused)) {
    renderer.render({ progress, time: animationTime, pointerX: pointer.x, pointerY: pointer.y });
    lastDraw = timestamp;
  }
  const needsFrame = film.open ? !paused && !filmPaused : !paused || Math.abs(target - progress) > 0.0002;
  if (!document.hidden && needsFrame) requestFrame();
}

function requestFrame() {
  if (frame === undefined) frame = requestAnimationFrame(render);
}

document.querySelectorAll('[data-depth]').forEach(button => {
  button.addEventListener('click', event => {
    event.preventDefault();
    goToDepth(Number(button.dataset.depth));
  });
});

pauseButton.addEventListener('click', () => {
  paused = !paused;
  updatePause();
  requestFrame();
});

menuButton.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!isOpen));
  menuButton.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
  mobileNavigation.hidden = isOpen;
});

document.querySelectorAll('[data-panel]').forEach(button => {
  button.addEventListener('click', () => {
    closeMenu();
    const story = button.dataset.panel === 'story';
    document.querySelector('#panel-title').textContent = story ? 'Our story' : 'Journal';
    document.querySelector('#panel-copy').textContent = story
      ? 'This preview recreates the ocean experience in the supplied images. The original story page was not included in the reference.'
      : 'The reference includes this navigation label, but no journal articles were supplied. Return to the ocean to continue exploring.';
    panel.showModal();
  });
});
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => panel.close()));
panel.addEventListener('click', event => {
  const rect = panel.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) panel.close();
});

function setFilmPaused(value) {
  filmPaused = value;
  filmPause.setAttribute('aria-label', value ? 'Play cinematic journey' : 'Pause cinematic journey');
  filmPause.innerHTML = value ? 'Play journey <span aria-hidden="true">▷</span>' : 'Pause journey <span aria-hidden="true">Ⅱ</span>';
}

document.querySelector('#watch-film').addEventListener('click', () => {
  savedProgress = target;
  savedPaused = paused;
  filmElapsed = 0;
  setFilmPaused(paused);
  root.classList.add('film-open');
  film.showModal();
  requestFrame();
});
filmPause.addEventListener('click', () => {
  if (filmElapsed === 20) filmElapsed = 0;
  if (paused) {
    paused = false;
    updatePause();
  }
  setFilmPaused(!filmPaused);
  requestFrame();
});
document.querySelector('.film-close').addEventListener('click', () => film.close());
film.addEventListener('close', () => {
  root.classList.remove('film-open');
  paused = savedPaused;
  updatePause();
  target = savedProgress;
  progress = savedProgress;
  requestFrame();
});
film.addEventListener('wheel', event => {
  event.preventDefault();
  film.close();
  window.scrollBy({ top: event.deltaY, behavior: 'instant' });
}, { passive: false });

window.addEventListener('scroll', updateScrollState, { passive: true });
window.addEventListener('pointermove', event => {
  if (paused || reducedMotion.matches || event.pointerType !== 'mouse') return;
  pointer = { x: (event.clientX / innerWidth - 0.5) * 2, y: (event.clientY / innerHeight - 0.5) * 2 };
}, { passive: true });
window.addEventListener('resize', () => {
  renderer?.resize();
  updateScrollState();
  if (innerWidth > 600) closeMenu();
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMenu();
});
reducedMotion.addEventListener('change', () => {
  paused = reducedMotion.matches;
  pointer = { x: 0, y: 0 };
  updatePause();
  requestFrame();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(frame);
    frame = undefined;
  } else {
    lastTimestamp = 0;
    requestFrame();
  }
});
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  stage.classList.remove('scene-ready');
  stage.dataset.renderer = 'photographic-fallback';
  renderer = undefined;
});

updatePause();
updateScrollState();
try {
  const modulePath = canvas.dataset.scene === 'fft' ? './real/vendor/main.js' : './ocean-scene.js';
  const { createOceanScene } = await import(modulePath);
  renderer = await createOceanScene(canvas, {
    onError(error) {
      stage.classList.remove('scene-ready');
      stage.dataset.renderer = 'unavailable';
      const status = document.querySelector('#scene-status');
      if (status) { status.hidden = false; status.textContent = error.message; }
      paused = true;
      updatePause();
      renderer?.dispose();
      renderer = undefined;
    },
  });
  stage.classList.add('scene-ready');
  stage.dataset.renderer = renderer.kind || 'webgl';
  const status = document.querySelector('#scene-status');
  if (status) status.hidden = true;
  requestFrame();
} catch (error) {
  stage.dataset.renderer = canvas.dataset.scene === 'fft' ? 'unavailable' : 'photographic-fallback';
  const status = document.querySelector('#scene-status');
  if (status) status.textContent = `This ocean preview could not start. ${error.message} Try a recent Chrome or Edge with graphics acceleration enabled.`;
  console.warn('Ocean animation could not start.', error.message);
}
window.addEventListener('pagehide', event => {
  if (!event.persisted) renderer?.dispose();
});
