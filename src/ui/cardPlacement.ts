const MARGIN = 12;
/** Below this width the dispatcher panel sits at the bottom instead of on the right. */
const NARROW = 760;

/**
 * Places a floating card next to the click, inside the part of the screen the
 * dispatcher panel doesn't cover (right side on wide screens, bottom on narrow ones).
 */
export function placeCard(el: HTMLElement, screen: { x: number; y: number }): void {
  const panel = document.querySelector<HTMLElement>('.panel');
  const narrow = window.innerWidth <= NARROW;
  const right = !narrow && panel ? panel.offsetWidth + 16 : 0;
  const bottom = narrow && panel ? panel.offsetHeight + MARGIN : 0;
  const maxX = window.innerWidth - el.offsetWidth - MARGIN - right;
  const maxY = window.innerHeight - el.offsetHeight - MARGIN - bottom;
  el.style.left = `${Math.max(MARGIN, Math.min(screen.x + 14, maxX))}px`;
  el.style.top = `${Math.max(MARGIN, Math.min(screen.y - 20, maxY))}px`;
}
