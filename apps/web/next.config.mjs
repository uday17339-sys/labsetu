/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits a self-contained server bundle with only the node_modules it actually
  // uses — the difference between a ~1.2 GB image and a ~200 MB one.
  output: 'standalone',
  // The monorepo root, so standalone tracing picks up the workspace packages.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  // The workspace packages ship TypeScript sources compiled to CJS; Next needs
  // to transpile them rather than treat them as external.
  transpilePackages: ['@labsetu/contracts'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Patient data must never end up in a browser or CDN cache on a
          // shared lab machine.
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
        ],
      },
    ];
  },
};

export default nextConfig;
