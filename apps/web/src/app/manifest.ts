import type { MetadataRoute } from 'next';

/**
 * PWA manifest.
 *
 * Installable on a phlebotomist's phone: collection rounds and barcode scanning
 * happen away from a desk, and a home-screen icon with no browser chrome is the
 * difference between "an app" and "a website they have to find again".
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'LabSetu — Laboratory Information Management',
    short_name: 'LabSetu',
    description: 'India-first, audit-grade LIMS for diagnostic laboratories',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f6f7f9',
    theme_color: '#21252e',
    categories: ['medical', 'productivity'],
    icons: [
      { src: '/icon', sizes: '256x256', type: 'image/png', purpose: 'any' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  };
}
