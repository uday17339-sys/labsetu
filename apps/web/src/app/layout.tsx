import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'LabSetu — Laboratory Information Management',
    template: '%s · LabSetu',
  },
  description: 'India-first, audit-grade LIMS for diagnostic laboratories',
  applicationName: 'LabSetu',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'LabSetu',
    // Matches the app chrome so an installed PWA does not show a white notch bar.
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    // Stops iOS turning accession numbers into phone links.
    telephone: false,
  },
  robots: {
    // A LIMS must never be indexed, hosted or not.
    index: false,
    follow: false,
    nocache: true,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom is NOT disabled. Lab staff read small numeric values; taking away
  // pinch-zoom to make an app feel "native" is an accessibility failure.
  maximumScale: 5,
  themeColor: '#21252e',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
