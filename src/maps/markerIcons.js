// src/maps/markerIcons.js

export function createDetourIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
      <defs>
        <filter id="ds" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="rgba(0,0,0,0.35)"/>
        </filter>
      </defs>
      <circle cx="10" cy="10" r="6.5" fill="#ffffff" stroke="rgba(60,64,67,0.55)" stroke-width="2" filter="url(#ds)"/>
    </svg>
  `.trim();

  const url = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  const { Size, Point } = window.google.maps;

  return { url, scaledSize: new Size(20, 20), anchor: new Point(10, 10) };
}

// Start marker: green dot (no "A")
export function createStartIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
      <defs>
        <filter id="ds" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="rgba(0,0,0,0.35)"/>
        </filter>
      </defs>
      <circle cx="13" cy="13" r="9.2" fill="#34A853" filter="url(#ds)"/>
      <circle cx="13" cy="13" r="4.2" fill="#ffffff"/>
    </svg>
  `.trim();

  const url = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  const { Size, Point } = window.google.maps;

  return { url, scaledSize: new Size(26, 26), anchor: new Point(13, 13) };
}

// Destination marker: red pin (no "B")
export function createEndIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44">
      <defs>
        <filter id="ds" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.4" flood-color="rgba(0,0,0,0.35)"/>
        </filter>
      </defs>
      <path
        d="M16 1
           C8.4 1 2.2 7.2 2.2 14.8
           C2.2 25.0 16 43 16 43
           C16 43 29.8 25.0 29.8 14.8
           C29.8 7.2 23.6 1 16 1 Z"
        fill="#EA4335"
        stroke="#ffffff"
        stroke-width="2"
        filter="url(#ds)"
      />
      <circle cx="16" cy="15" r="6.2" fill="#ffffff" opacity="0.95"/>
      <circle cx="16" cy="15" r="3.4" fill="#EA4335" opacity="0.95"/>
    </svg>
  `.trim();

  const url = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  const { Size, Point } = window.google.maps;

  return { url, scaledSize: new Size(32, 44), anchor: new Point(16, 43) };
}
