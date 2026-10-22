const root = document.documentElement;
const label = (english, chinese) => root.lang === 'zh-CN' ? chinese : english;
const stage = document.querySelector('#ocean-stage');
const canvas = document.querySelector('#ocean-canvas');
const loader = document.querySelector('#scene-loader');
const experience = document.querySelector('.ocean-experience');
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

function showLoadingError() {
  if (!loader) return;
  root.classList.add('scene-loading');
  loader.classList.add('has-error');
  loader.removeAttribute('aria-hidden');
  loader.setAttribute('aria-busy', 'false');
  experience.inert = true;
  experience.setAttribute('aria-busy', 'false');
  document.querySelector('#loader-title').textContent = '海洋暂时未能呈现';
  document.querySelector('#loader-message').textContent = '请重新加载，或直接进入案例库';
  document.querySelector('#loader-actions').hidden = false;
}
document.querySelector('#retry-scene')?.addEventListener('click', () => location.reload());

function scrollRange() {
  return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
}

function closeMenu() {
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', label('Open navigation', '打开导航'));
  mobileNavigation.hidden = true;
}

function goToDepth(depth) {
  closeMenu();
  window.scrollTo({ top: depth * scrollRange(), behavior: reducedMotion.matches ? 'instant' : 'smooth' });
}

function updatePause() {
  pauseButton.setAttribute('aria-pressed', String(paused));
  pauseButton.setAttribute('aria-label', paused ? label('Resume ocean animation', '继续海洋动画') : label('Pause ocean animation', '暂停海洋动画'));
  motionLabel.textContent = paused ? label('A moment of stillness', '动画已暂停') : label('Live at sea', '海洋律动');
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
  scrollLabel.textContent = submerged ? label('Scroll to resurface', '向上滚动 · 返回海面') : label('Scroll to explore', '向下滚动 · 沉浸探索');

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
  menuButton.setAttribute('aria-label', isOpen ? label('Open navigation', '打开导航') : label('Close navigation', '关闭导航'));
  mobileNavigation.hidden = isOpen;
});

document.querySelectorAll('[data-panel]').forEach(button => {
  button.addEventListener('click', () => {
    closeMenu();
    const story = button.dataset.panel === 'story';
    document.querySelector('#panel-title').textContent = story ? label('Our story', '关于平台') : label('Journal', '使用指南');
    document.querySelector('#panel-copy').textContent = story
      ? label('This preview recreates the ocean experience in the supplied images. The original story page was not included in the reference.', '智能体案例平台汇集不同学科与课程的智能体应用案例，帮助教师从教学问题出发，了解案例的应用场景、课程信息与使用方法，为教学实践寻找可参考的思路。')
      : label('The reference includes this navigation label, but no journal articles were supplied. Return to the ocean to continue exploring.', '进入案例库后，可输入名称、学科、课程或教学痛点检索，也可按学科与学校筛选。点击案例查看详细信息与使用说明，通过案例中提供的链接访问智能体。需要进一步查找时，可使用“对话找智能体”描述你的需求。');
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
  filmPause.setAttribute('aria-label', value ? label('Play cinematic journey', '继续沉浸探索') : label('Pause cinematic journey', '暂停沉浸探索'));
  filmPause.innerHTML = value ? `${label('Play journey', '继续探索')} <span aria-hidden="true">▷</span>` : `${label('Pause journey', '暂停探索')} <span aria-hidden="true">Ⅱ</span>`;
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
  const modulePath = canvas.dataset.scene === 'fft' ? './real/vendor/main.js?v=first-frame' : './ocean-scene.js';
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
      showLoadingError();
    },
  });
  stage.classList.add('scene-ready');
  stage.dataset.renderer = renderer.kind || 'webgl';
  const status = document.querySelector('#scene-status');
  if (status) status.hidden = true;
  requestFrame();
  if (loader) {
    // The renderer has completed its first GPU frame. Let the visible canvas
    // reach a paint before removing the opaque entrance screen.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (stage.classList.contains('scene-ready')) {
      experience.inert = false;
      experience.setAttribute('aria-busy', 'false');
      loader.setAttribute('aria-busy', 'false');
      loader.setAttribute('aria-hidden', 'true');
      root.classList.remove('scene-loading');
    }
  }
} catch (error) {
  stage.dataset.renderer = canvas.dataset.scene === 'fft' ? 'unavailable' : 'photographic-fallback';
  const status = document.querySelector('#scene-status');
  if (status) status.textContent = label(`This ocean preview could not start. ${error.message} Try a recent Chrome or Edge with graphics acceleration enabled.`, '海洋场景暂时无法加载，请尝试开启浏览器图形加速。你仍可直接进入案例库。');
  showLoadingError();
  console.warn('Ocean animation could not start.', error.message);
}
window.addEventListener('pagehide', event => {
  if (!event.persisted) renderer?.dispose();
});
