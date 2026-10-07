import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: { brand: { DEFAULT: "#10b981", dark: "#047857" } },
    },
  },
  plugins: [],
};
export default config;
