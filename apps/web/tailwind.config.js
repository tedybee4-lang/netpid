/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Semantic tokens used across the dashboard pages. Without these,
      // classes like `bg-primary` / `text-muted-foreground` generate no CSS and
      // the page renders unstyled. Colours mirror the NETPID palette
      // (indigo brand, slate neutrals) defined in globals.css.
      colors: {
        border: "rgb(226 232 240)", // slate-200
        background: "rgb(248 250 252)", // slate-50 (body)
        foreground: "rgb(15 23 42)", // slate-900
        card: { DEFAULT: "rgb(255 255 255)", foreground: "rgb(15 23 42)" },
        primary: { DEFAULT: "rgb(79 70 229)", foreground: "rgb(255 255 255)" }, // indigo-600
        muted: { DEFAULT: "rgb(241 245 249)", foreground: "rgb(100 116 139)" }, // slate-100/500
        accent: { DEFAULT: "rgb(238 242 255)", foreground: "rgb(79 70 229)" }, // indigo-50
        destructive: { DEFAULT: "rgb(225 29 72)", foreground: "rgb(255 255 255)" },
        "muted-foreground": "rgb(100 116 139)", // slate-500
      },
    },
  },
  plugins: [],
};
