/** Small inline SVG icons (stroke = currentColor). */
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  fire: svg('<path d="M12 22c4 0 7-2.7 7-6.6 0-3.4-2.4-5.6-3.9-7.4-.4 1.9-1.3 3-2.6 3.6.4-3.3-.8-6.4-3.5-8.6.1 3.4-1.6 5.3-3.1 7.1C4.6 11.6 5 13 5 15.4 5 19.3 8 22 12 22z"/>'),
  crime: svg('<path d="M12 3l8 3v6c0 4.5-3.3 8-8 9-4.7-1-8-4.5-8-9V6z"/><path d="M12 8v5"/><path d="M12 16.5v.5"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  engine: svg('<rect x="2" y="9" width="13" height="8" rx="1"/><path d="M15 12h4l3 3v2h-7"/><circle cx="6" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/><path d="M3 6l9 3"/>'),
  car: svg('<path d="M4 16v-3l2-5h12l2 5v3"/><rect x="3" y="13" width="18" height="4" rx="1"/><circle cx="7" cy="18" r="1.4"/><circle cx="17" cy="18" r="1.4"/><path d="M10 5h4"/>'),
} as const;
