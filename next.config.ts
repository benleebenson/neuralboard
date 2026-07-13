import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/editor", destination: "/board2", permanent: true },
      { source: "/builder", destination: "/board2", permanent: true },
    ];
  },
};

export default nextConfig;
