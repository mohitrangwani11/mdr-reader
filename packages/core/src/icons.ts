/** One consistent inline-SVG icon set (16px grid, 1.5 stroke, currentColor). */

const svg = (body: string) =>
  `<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  menu: svg('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
  search: svg('<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/>'),
  chevron: svg('<path d="M4.5 6.25 8 9.75l3.5-3.5"/>'),
  copy: svg('<rect x="5.25" y="5.25" width="8" height="8" rx="1.75"/><path d="M10.75 5.25V3.5a1.25 1.25 0 0 0-1.25-1.25h-6A1.25 1.25 0 0 0 2.25 3.5v6a1.25 1.25 0 0 0 1.25 1.25h1.75"/>'),
  focus: svg('<circle cx="8" cy="8" r="2"/><path d="M2.25 5.5V3.5c0-.7.55-1.25 1.25-1.25h2M10.5 2.25h2c.7 0 1.25.55 1.25 1.25v2M13.75 10.5v2c0 .7-.55 1.25-1.25 1.25h-2M5.5 13.75h-2c-.7 0-1.25-.55-1.25-1.25v-2"/>'),
  reload: svg('<path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3"/><path d="M13.25 2.5v3.25H10"/>'),
  sun: svg('<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>'),
  moon: svg('<path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85Z"/>'),
  auto: svg('<circle cx="8" cy="8" r="5.75"/><path d="M8 2.25v11.5A5.75 5.75 0 0 0 8 2.25Z" fill="currentColor" stroke="none"/>'),
  more: svg('<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  share: svg('<path d="M8 10V2.5M5 5.25 8 2.25l3 3"/><path d="M3.25 8.5v3.75c0 .7.55 1.25 1.25 1.25h7c.7 0 1.25-.55 1.25-1.25V8.5"/>'),
  link: svg('<path d="M6.75 9.25 9.25 6.75M7.25 4.5l.9-.9a2.65 2.65 0 0 1 3.75 3.75l-.9.9M8.75 11.5l-.9.9a2.65 2.65 0 0 1-3.75-3.75l.9-.9"/>'),
  keyboard: svg('<rect x="1.75" y="4" width="12.5" height="8" rx="1.5"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h-.5M5 9.5h6"/>'),
  version: svg('<path d="M4 2.25v7.5M4 9.75a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM12 6.25a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM12 6.25c0 3-3 3.5-6.4 4.2"/>'),
  file: svg('<path d="M9 2.25H4.75c-.7 0-1.25.55-1.25 1.25v9c0 .7.55 1.25 1.25 1.25h6.5c.7 0 1.25-.55 1.25-1.25V5.75L9 2.25Z"/><path d="M9 2.25v3.5h3.5"/>'),
  x: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  check: svg('<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>'),
} as const;

export type IconName = keyof typeof icons;
