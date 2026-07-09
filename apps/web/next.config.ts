import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      {
        protocol: "https",
        hostname: "ywbnsoymqgpbqotfiydp.supabase.co",
      },
    ],
  },
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
