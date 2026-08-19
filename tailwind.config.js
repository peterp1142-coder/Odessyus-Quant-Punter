/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./client/index.html",
    "./client/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      colors: {
        'bg-deep': '#060a12',
        'bg-dark': '#0d1424',
        'bg-card': '#111827',
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'fade-in-up': 'fade-in-up 0.25s ease-out both',
        'slide-in': 'slide-in 0.2s ease-out both',
        'stream-in': 'stream-in 0.3s ease-out both',
      },
    },
  },
  plugins: [],
};
