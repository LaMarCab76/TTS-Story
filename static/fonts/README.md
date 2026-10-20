# Bundled fonts

These web fonts are self-hosted so the TTS-Story interface (and its icons) render correctly offline.
They are loaded by `static/css/studio.css` via `@font-face`.

| File | Family | Axes / weights | Source | License |
|---|---|---|---|---|
| `instrument-sans-latin.woff2` | Instrument Sans | variable, wght 400–600 | Google Fonts | SIL Open Font License 1.1 |
| `instrument-serif-latin.woff2` | Instrument Serif | 400 | Google Fonts | SIL Open Font License 1.1 |
| `newsreader-latin.woff2` | Newsreader | variable, opsz 6–72, wght 400–500 | Google Fonts | SIL Open Font License 1.1 |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | variable, wght 400–500 | Google Fonts | SIL Open Font License 1.1 |
| `material-symbols-outlined.woff2` | Material Symbols Outlined | variable, opsz 20–48, wght 100–700, FILL 0–1, GRAD | Google Fonts (Google Material Symbols) | Apache License 2.0 |

The four text fonts are the Google Fonts "latin" subsets
(unicode-range `U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD`);
characters outside that range fall back to the system font stacks declared in `studio.css`.

- SIL Open Font License 1.1: https://openfontlicense.org
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0
