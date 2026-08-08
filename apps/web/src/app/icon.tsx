import { ImageResponse } from 'next/og';

// Generated at build time so there is no binary asset to keep in sync with the
// brand colours defined in globals.css.
export const size = { width: 256, height: 256 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1f63c9',
          color: 'white',
          fontSize: 116,
          fontWeight: 700,
          letterSpacing: -4,
          borderRadius: 48,
        }}
      >
        LS
      </div>
    ),
    size,
  );
}
