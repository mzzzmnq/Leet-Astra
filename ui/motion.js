// Keep the intended visibility separate from hidden while an exit animation runs.
function createViewMotion(element, { duration = 420, beforeShow = () => {}, afterHide = () => {} } = {}) {
  let visible = !element.hidden;
  let animation = null;

  function syncInteraction() {
    element.inert = !visible;
    element.setAttribute('aria-hidden', String(!visible));
  }
  function settle() {
    element.hidden = !visible;
    syncInteraction();
    if (!visible) afterHide();
  }
  function cancelAnimation() {
    const previous = animation;
    animation = null;
    if (previous) previous.cancel();
  }
  function finish() {
    if (!animation) return;
    cancelAnimation();
    settle();
  }
  function setVisible(next) {
    next = Boolean(next);
    if (next === visible) return visible;

    // Capture an interrupted frame before cancelling its fill effect.
    const current = animation || !element.hidden ? window.getComputedStyle(element) : null;
    const start = current ? { opacity: current.opacity } : null;
    cancelAnimation();
    visible = next;
    syncInteraction();
    if (visible) {
      element.hidden = false;
      beforeShow();
    }

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || typeof element.animate !== 'function' || duration <= 0) {
      settle();
      return visible;
    }

    const resting = { opacity: '1' };
    const displaced = { opacity: '0' };
    const running = element.animate([
      start || (visible ? displaced : resting),
      visible ? resting : displaced,
    ], {
      duration: visible ? duration : Math.min(duration, 320),
      easing: 'ease-in-out',
      fill: 'both',
    });
    animation = running;
    running.onfinish = () => {
      if (animation !== running) return;
      cancelAnimation();
      settle();
    };
    return visible;
  }

  syncInteraction();
  return { setVisible, toggle: () => setVisible(!visible), isVisible: () => visible, finish };
}

// Fade new content when it becomes visible, including the first streamed answer.
function fadeInMessage(element) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof element.animate !== 'function') return;
  const animation = element.animate([{ opacity: '0' }, { opacity: '1' }], {
    duration: 400, easing: 'ease-in-out', fill: 'both',
  });
  animation.onfinish = () => animation.cancel();
}
