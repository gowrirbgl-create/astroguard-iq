import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    proxyTimeout: 120000,
  },
  async rewrites() {
    return [
      {
        source: "/api/qml/:path*",
        destination: "http://127.0.0.1:8000/qml/:path*",
      },
    ];
  },
};

export default nextConfig;