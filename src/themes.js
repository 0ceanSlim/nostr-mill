/**
 * MILL — themes.js
 * CSS custom property theming system.
 * Consumers can pass a partial theme object and only override what they need.
 */

/** Full set of MILL CSS custom properties and their default (dark) values. */
export const MILL_CSS_VARS = [
  '--mill-bg',
  '--mill-surface',
  '--mill-card',
  '--mill-card-hover',
  '--mill-inset',
  '--mill-inset-strong',
  '--mill-overlay',
  '--mill-border',
  '--mill-border-light',
  '--mill-accent',
  '--mill-accent-hover',
  '--mill-accent-dim',
  '--mill-teal',
  '--mill-teal-dim',
  '--mill-text',
  '--mill-text-secondary',
  '--mill-muted',
  '--mill-danger',
  '--mill-danger-dim',
  '--mill-warning',
  '--mill-warning-dim',
  '--mill-success',
  '--mill-success-dim',
  '--mill-radius',
  '--mill-border-width',
  '--mill-border-style',
  '--mill-shadow',
  '--mill-font',
  '--mill-font-mono',
];

/** Built-in themes */
export const THEMES = {

  dark: {
    '--mill-bg':             '#09080f',
    '--mill-surface':        '#100e1b',
    '--mill-card':           '#181528',
    '--mill-card-hover':     '#1f1c35',
    '--mill-inset':          'rgba(0,0,0,0.25)',
    '--mill-inset-strong':   'rgba(0,0,0,0.35)',
    '--mill-overlay':        'rgba(4,3,10,0.78)',
    '--mill-border':         '#2a2544',
    '--mill-border-light':   '#3e3860',
    '--mill-accent':         'oklch(0.67 0.28 282)',
    '--mill-accent-hover':   'oklch(0.73 0.28 282)',
    '--mill-accent-dim':     'oklch(0.67 0.28 282 / 0.13)',
    '--mill-teal':           'oklch(0.67 0.18 195)',
    '--mill-teal-dim':       'oklch(0.67 0.18 195 / 0.13)',
    '--mill-text':           '#ede8fc',
    '--mill-text-secondary': '#9d94c0',
    '--mill-muted':          '#5e5880',
    '--mill-danger':         'oklch(0.65 0.24 15)',
    '--mill-danger-dim':     'oklch(0.65 0.24 15 / 0.13)',
    '--mill-warning':        'oklch(0.78 0.18 65)',
    '--mill-warning-dim':    'oklch(0.78 0.18 65 / 0.13)',
    '--mill-success':        'oklch(0.7 0.2 155)',
    '--mill-success-dim':    'oklch(0.7 0.2 155 / 0.13)',
    '--mill-radius':         '14px',
    '--mill-border-width':   '1px',
    '--mill-border-style':   'solid',
    '--mill-shadow':         '0 0 0 1px rgba(130,80,255,0.08), 0 24px 64px rgba(0,0,0,0.7), 0 0 80px oklch(0.67 0.28 282 / 0.06)',
    '--mill-font':           "'Space Grotesk', 'DM Sans', system-ui, sans-serif",
    '--mill-font-mono':      "'JetBrains Mono', 'Fira Code', monospace",
  },

  light: {
    '--mill-bg':             '#f5f3ff',
    '--mill-surface':        '#ffffff',
    '--mill-card':           '#f8f7fe',
    '--mill-card-hover':     '#efedfb',
    '--mill-inset':          'rgba(20,14,40,0.05)',
    '--mill-inset-strong':   'rgba(20,14,40,0.08)',
    '--mill-overlay':        'rgba(60,40,120,0.30)',
    '--mill-border':         '#ddd9f5',
    '--mill-border-light':   '#c5c0e8',
    '--mill-accent':         'oklch(0.5 0.25 282)',
    '--mill-accent-hover':   'oklch(0.44 0.25 282)',
    '--mill-accent-dim':     'oklch(0.5 0.25 282 / 0.10)',
    '--mill-teal':           'oklch(0.45 0.18 195)',
    '--mill-teal-dim':       'oklch(0.45 0.18 195 / 0.10)',
    '--mill-text':           '#1a1630',
    '--mill-text-secondary': '#534d7a',
    '--mill-muted':          '#9990bb',
    '--mill-danger':         'oklch(0.5 0.24 15)',
    '--mill-danger-dim':     'oklch(0.5 0.24 15 / 0.10)',
    '--mill-warning':        'oklch(0.55 0.18 65)',
    '--mill-warning-dim':    'oklch(0.55 0.18 65 / 0.10)',
    '--mill-success':        'oklch(0.45 0.2 155)',
    '--mill-success-dim':    'oklch(0.45 0.2 155 / 0.10)',
    '--mill-radius':         '14px',
    '--mill-border-width':   '1px',
    '--mill-border-style':   'solid',
    '--mill-shadow':         '0 8px 32px rgba(60,40,120,0.18)',
    '--mill-font':           "'Space Grotesk', 'DM Sans', system-ui, sans-serif",
    '--mill-font-mono':      "'JetBrains Mono', 'Fira Code', monospace",
  },

  minimal: {
    '--mill-bg':             '#fafafa',
    '--mill-surface':        '#ffffff',
    '--mill-card':           '#f4f4f4',
    '--mill-card-hover':     '#ececec',
    '--mill-inset':          'rgba(0,0,0,0.04)',
    '--mill-inset-strong':   'rgba(0,0,0,0.07)',
    '--mill-overlay':        'rgba(0,0,0,0.45)',
    '--mill-border':         '#e2e2e2',
    '--mill-border-light':   '#cacaca',
    '--mill-accent':         '#111111',
    '--mill-accent-hover':   '#333333',
    '--mill-accent-dim':     'rgba(0,0,0,0.07)',
    '--mill-teal':           '#555555',
    '--mill-teal-dim':       'rgba(0,0,0,0.07)',
    '--mill-text':           '#111111',
    '--mill-text-secondary': '#555555',
    '--mill-muted':          '#aaaaaa',
    '--mill-danger':         '#cc2222',
    '--mill-danger-dim':     'rgba(204,34,34,0.08)',
    '--mill-warning':        '#c07700',
    '--mill-warning-dim':    'rgba(192,119,0,0.08)',
    '--mill-success':        '#1a8a4a',
    '--mill-success-dim':    'rgba(26,138,74,0.08)',
    '--mill-radius':         '8px',
    '--mill-border-width':   '1px',
    '--mill-border-style':   'solid',
    '--mill-shadow':         '0 8px 24px rgba(0,0,0,0.10)',
    '--mill-font':           "'Inter', system-ui, sans-serif",
    '--mill-font-mono':      "'IBM Plex Mono', monospace",
  },

  // Branded theme — green/grain
  grain: {
    '--mill-bg':             '#0d0f0c',
    '--mill-surface':        '#141710',
    '--mill-card':           '#1a1f16',
    '--mill-card-hover':     '#222820',
    '--mill-inset':          'rgba(0,0,0,0.25)',
    '--mill-inset-strong':   'rgba(0,0,0,0.35)',
    '--mill-overlay':        'rgba(8,12,6,0.78)',
    '--mill-border':         '#2c3226',
    '--mill-border-light':   '#3d4736',
    '--mill-accent':         'oklch(0.67 0.22 142)',   /* green */
    '--mill-accent-hover':   'oklch(0.73 0.22 142)',
    '--mill-accent-dim':     'oklch(0.67 0.22 142 / 0.13)',
    '--mill-teal':           'oklch(0.67 0.18 175)',
    '--mill-teal-dim':       'oklch(0.67 0.18 175 / 0.13)',
    '--mill-text':           '#e8f0e4',
    '--mill-text-secondary': '#8ea882',
    '--mill-muted':          '#506048',
    '--mill-danger':         'oklch(0.65 0.22 25)',
    '--mill-danger-dim':     'oklch(0.65 0.22 25 / 0.13)',
    '--mill-warning':        'oklch(0.78 0.18 80)',
    '--mill-warning-dim':    'oklch(0.78 0.18 80 / 0.13)',
    '--mill-success':        'oklch(0.7 0.22 142)',
    '--mill-success-dim':    'oklch(0.7 0.22 142 / 0.13)',
    '--mill-radius':         '12px',
    '--mill-border-width':   '1px',
    '--mill-border-style':   'solid',
    '--mill-shadow':         '0 0 0 1px rgba(120,200,140,0.10), 0 24px 64px rgba(0,0,0,0.7), 0 0 80px oklch(0.7 0.22 142 / 0.06)',
    '--mill-font':           "'Space Grotesk', system-ui, sans-serif",
    '--mill-font-mono':      "'JetBrains Mono', monospace",
  },
};

/**
 * Apply a theme to a target element (defaults to :host of shadow DOM or document.documentElement).
 * @param {string|object} theme  - Built-in name ('dark','light','minimal','grain') or partial token object
 * @param {HTMLElement}   target - Where to apply CSS vars (default: document.documentElement)
 */
export function applyTheme(theme, target = document.documentElement) {
  const tokens = typeof theme === 'string'
    ? THEMES[theme] ?? THEMES.dark
    : { ...THEMES.dark, ...theme };           // merge partials onto dark baseline

  for (const [prop, val] of Object.entries(tokens)) {
    target.style.setProperty(prop, val);
  }
}

/**
 * Generate a minimal theme from just a few brand inputs.
 * @param {{ accent: string, bg?: string, radius?: string, font?: string }} opts
 */
export function brandTheme({ accent, bg, radius, font } = {}) {
  return {
    ...THEMES.dark,
    ...(accent ? {
      '--mill-accent':       accent,
      '--mill-accent-hover': accent,        // caller can fine-tune
      '--mill-accent-dim':   accent + '22', // rough alpha — works for hex
      '--mill-success':      accent,
      '--mill-success-dim':  accent + '22',
    } : {}),
    ...(bg     ? { '--mill-bg': bg, '--mill-surface': bg } : {}),
    ...(radius ? { '--mill-radius': radius } : {}),
    ...(font   ? { '--mill-font': font } : {}),
  };
}
