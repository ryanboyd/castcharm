"use strict";

const THEMES = {

  // ── Very dark ───────────────────────────────────────────────

  midnight: {
    label: "Midnight",
    bg2: "#161b27", primary: "#6366f1", labelColor: "#9090b0",
    vars: {
      "--bg": "#0e1117", "--bg-2": "#161b27", "--bg-3": "#1e2435",
      "--border": "#2a3149", "--border-2": "#3a4263",
      "--primary": "#6366f1", "--primary-hover": "#4f51cc", "--primary-light": "rgba(99,102,241,0.12)",
      "--text": "#e2e8f0", "--text-2": "#94a3b8", "--text-3": "#64748b",
      "--shadow": "0 2px 12px rgba(0,0,0,0.4)",
      "--chart-2": "#10b981",
    },
  },
  abyss: {
    label: "Abyss",
    bg2: "#0a0e14", primary: "#22d3ee", labelColor: "#446070",
    vars: {
      "--bg": "#050709", "--bg-2": "#0a0e14", "--bg-3": "#10161e",
      "--border": "#182030", "--border-2": "#222e3d",
      "--primary": "#22d3ee", "--primary-hover": "#06b6d4", "--primary-light": "rgba(34,211,238,0.12)",
      "--text": "#ddeeff", "--text-2": "#6898b0", "--text-3": "#486878",
      "--shadow": "0 2px 16px rgba(0,0,0,0.7)",
      "--chart-2": "#f97316",
    },
  },
  galaxy: {
    label: "Galaxy",
    bg2: "#0c0820", primary: "#d946ef", labelColor: "#7050a8",
    vars: {
      "--bg": "#060310", "--bg-2": "#0c0820", "--bg-3": "#140e30",
      "--border": "#201840", "--border-2": "#302458",
      "--primary": "#d946ef", "--primary-hover": "#c026d3", "--primary-light": "rgba(217,70,239,0.12)",
      "--text": "#f0e8ff", "--text-2": "#a888d8", "--text-3": "#7858a8",
      "--shadow": "0 2px 20px rgba(0,0,0,0.8)",
      "--chart-2": "#38bdf8",
    },
  },
  espresso: {
    label: "Espresso",
    bg2: "#221408", primary: "#cd853f", labelColor: "#7a5838",
    vars: {
      "--bg": "#180d07", "--bg-2": "#221408", "--bg-3": "#2c1c0e",
      "--border": "#3a2818", "--border-2": "#4e3825",
      "--primary": "#cd853f", "--primary-hover": "#a86c28", "--primary-light": "rgba(205,133,63,0.12)",
      "--text": "#f5e8d8", "--text-2": "#c0987a", "--text-3": "#8a6850",
      "--chart-2": "#38bdf8",
      "--shadow": "0 2px 12px rgba(0,0,0,0.6)",
    },
  },
  lava: {
    label: "Lava",
    bg2: "#1c0800", primary: "#ff5e00", labelColor: "#803820",
    vars: {
      "--bg": "#110400", "--bg-2": "#1c0800", "--bg-3": "#280e00",
      "--border": "#440f00", "--border-2": "#5a1800",
      "--primary": "#ff5e00", "--primary-hover": "#dd4800", "--primary-light": "rgba(255,94,0,0.12)",
      "--text": "#fff0e0", "--text-2": "#d07848", "--text-3": "#a04820",
      "--chart-2": "#38bdf8",
      "--shadow": "0 2px 12px rgba(0,0,0,0.6)",
    },
  },
  terminal: {
    label: "Terminal",
    bg2: "#071207", primary: "#00ff41", labelColor: "#2a8030",
    vars: {
      "--bg": "#030a03", "--bg-2": "#071207", "--bg-3": "#0b1a0b",
      "--border": "#0d2a0d", "--border-2": "#153815",
      "--primary": "#00ff41", "--primary-hover": "#00cc33", "--primary-light": "rgba(0,255,65,0.10)",
      "--text": "#ccffcc", "--text-2": "#66cc66", "--text-3": "#338833",
      "--chart-2": "#f97316",
      "--shadow": "0 2px 12px rgba(0,0,0,0.6)",
    },
  },
  amber: {
    label: "Amber",
    bg2: "#150e00", primary: "#ffa500", labelColor: "#806010",
    vars: {
      "--bg": "#0c0900", "--bg-2": "#150e00", "--bg-3": "#1e1500",
      "--border": "#302000", "--border-2": "#403000",
      "--primary": "#ffa500", "--primary-hover": "#e08c00", "--primary-light": "rgba(255,165,0,0.12)",
      "--text": "#ffe8a0", "--text-2": "#cc9838", "--text-3": "#886420",
      "--chart-2": "#60a5fa",
      "--shadow": "0 2px 12px rgba(0,0,0,0.5)",
    },
  },

  // ── Dark with personality ────────────────────────────────────

  arcane: {
    label: "Arcane",
    bg2: "#130a22", primary: "#c9a227", labelColor: "#806830",
    vars: {
      "--bg": "#0d0618", "--bg-2": "#130a22", "--bg-3": "#1a102e",
      "--border": "#2e1850", "--border-2": "#3e2068",
      "--primary": "#c9a227", "--primary-hover": "#a07820", "--primary-light": "rgba(201,162,39,0.12)",
      "--text": "#e8deff", "--text-2": "#b090e0", "--text-3": "#8060aa",
      "--chart-2": "#a78bfa",
      "--shadow": "0 2px 16px rgba(0,0,0,0.6)",
    },
  },
  psychedelic: {
    label: "Psychedelic",
    bg2: "#150028", primary: "#ff00cc", labelColor: "#9900aa",
    vars: {
      "--bg": "#0a0015", "--bg-2": "#150028", "--bg-3": "#20003a",
      "--border": "#600090", "--border-2": "#8800cc",
      "--primary": "#ff00cc", "--primary-hover": "#dd00aa", "--primary-light": "rgba(255,0,204,0.15)",
      "--text": "#fffaff", "--text-2": "#dd88ff", "--text-3": "#aa44ff",
      "--chart-2": "#22d3ee",
      "--shadow": "0 2px 20px rgba(255,0,204,0.2)",
    },
  },
  neon_tokyo: {
    label: "Neon Tokyo",
    bg2: "#100e1c", primary: "#ff2d78", labelColor: "#882050",
    vars: {
      "--bg": "#080610", "--bg-2": "#100e1c", "--bg-3": "#181628",
      "--border": "#2a2244", "--border-2": "#382e58",
      "--primary": "#ff2d78", "--primary-hover": "#e01560", "--primary-light": "rgba(255,45,120,0.12)",
      "--text": "#ffe8f8", "--text-2": "#d080b8", "--text-3": "#a05090",
      "--chart-2": "#22d3ee",
      "--shadow": "0 2px 20px rgba(255,45,120,0.15)",
    },
  },
  cyberpunk: {
    label: "Cyberpunk",
    bg2: "#121212", primary: "#efe000", labelColor: "#787830",
    vars: {
      "--bg": "#090909", "--bg-2": "#121212", "--bg-3": "#1a1a1a",
      "--border": "#2a2a2a", "--border-2": "#3a3a3a",
      "--primary": "#efe000", "--primary-hover": "#c8bb00", "--primary-light": "rgba(239,224,0,0.10)",
      "--text": "#fffff0", "--text-2": "#b0b090", "--text-3": "#707050",
      "--chart-2": "#e879f9",
      "--shadow": "0 2px 12px rgba(0,0,0,0.6)",
    },
  },
  dracula: {
    label: "Dracula",
    bg2: "#282a36", primary: "#ff79c6", labelColor: "#8090b8",
    vars: {
      "--bg": "#1e1f29", "--bg-2": "#282a36", "--bg-3": "#21222d",
      "--border": "#44475a", "--border-2": "#545770",
      "--primary": "#ff79c6", "--primary-hover": "#ff5bab", "--primary-light": "rgba(255,121,198,0.12)",
      "--text": "#f8f8f2", "--text-2": "#8090c0", "--text-3": "#6272a4",
      "--chart-2": "#8be9fd",
      "--shadow": "0 2px 12px rgba(0,0,0,0.4)",
    },
  },
  forest: {
    label: "Forest",
    bg2: "#162818", primary: "#4ade80", labelColor: "#4a8858",
    vars: {
      "--bg": "#0e1f12", "--bg-2": "#162818", "--bg-3": "#1c3220",
      "--border": "#28482e", "--border-2": "#386040",
      "--primary": "#4ade80", "--primary-hover": "#22c55e", "--primary-light": "rgba(74,222,128,0.12)",
      "--text": "#dcf5e4", "--text-2": "#7abf88", "--text-3": "#4a8858",
      "--chart-2": "#fb923c",
      "--shadow": "0 2px 12px rgba(0,0,0,0.5)",
    },
  },
  dusk: {
    label: "Dusk",
    bg2: "#241e3d", primary: "#e879f9", labelColor: "#8060a8",
    vars: {
      "--bg": "#1c1530", "--bg-2": "#241e3d", "--bg-3": "#2c254a",
      "--border": "#3e3265", "--border-2": "#524280",
      "--primary": "#e879f9", "--primary-hover": "#d946ef", "--primary-light": "rgba(232,121,249,0.12)",
      "--text": "#f5e8ff", "--text-2": "#c0a0dd", "--text-3": "#8a6aaa",
      "--chart-2": "#38bdf8",
      "--shadow": "0 2px 12px rgba(0,0,0,0.5)",
    },
  },
  caramel: {
    label: "Caramel",
    bg2: "#301e0a", primary: "#fb923c", labelColor: "#906840",
    vars: {
      "--bg": "#251808", "--bg-2": "#301e0a", "--bg-3": "#3c2710",
      "--border": "#503822", "--border-2": "#664830",
      "--primary": "#fb923c", "--primary-hover": "#f97316", "--primary-light": "rgba(251,146,60,0.12)",
      "--text": "#faebd7", "--text-2": "#d4a870", "--text-3": "#a87840",
      "--chart-2": "#60a5fa",
      "--shadow": "0 2px 12px rgba(0,0,0,0.5)",
    },
  },

  // ── Medium ───────────────────────────────────────────────────

  nord: {
    label: "Nord",
    bg2: "#3b4252", primary: "#88c0d0", labelColor: "#6888a0",
    vars: {
      "--bg": "#2e3440", "--bg-2": "#3b4252", "--bg-3": "#434c5e",
      "--border": "#4c566a", "--border-2": "#5c6880",
      "--primary": "#88c0d0", "--primary-hover": "#81a1c1", "--primary-light": "rgba(136,192,208,0.12)",
      "--text": "#eceff4", "--text-2": "#d0dae8", "--text-3": "#8898a8",
      "--chart-2": "#ebcb8b",
      "--shadow": "0 2px 12px rgba(0,0,0,0.3)",
    },
  },
  solarized: {
    label: "Solarized",
    bg2: "#073642", primary: "#268bd2", labelColor: "#4a6870",
    vars: {
      "--bg": "#002b36", "--bg-2": "#073642", "--bg-3": "#0e4050",
      "--border": "#405060", "--border-2": "#506878",
      "--primary": "#268bd2", "--primary-hover": "#1a6faa", "--primary-light": "rgba(38,139,210,0.12)",
      "--text": "#eee8d5", "--text-2": "#93a1a1", "--text-3": "#657b83",
      "--chart-2": "#2aa198",
      "--shadow": "0 2px 12px rgba(0,0,0,0.4)",
    },
  },
  ocean: {
    label: "Ocean",
    bg2: "#143040", primary: "#38bdf8", labelColor: "#407890",
    vars: {
      "--bg": "#0d2535", "--bg-2": "#143040", "--bg-3": "#1a3c50",
      "--border": "#264e68", "--border-2": "#346280",
      "--primary": "#38bdf8", "--primary-hover": "#0ea5e9", "--primary-light": "rgba(56,189,248,0.12)",
      "--text": "#e0f4ff", "--text-2": "#7abbd8", "--text-3": "#4a8aa8",
      "--chart-2": "#f97316",
      "--shadow": "0 2px 12px rgba(0,0,0,0.5)",
    },
  },
  denim: {
    label: "Denim",
    bg2: "#1e2a52", primary: "#93c5fd", labelColor: "#4868a0",
    vars: {
      "--bg": "#162040", "--bg-2": "#1e2a52", "--bg-3": "#263462",
      "--border": "#384880", "--border-2": "#4a5898",
      "--primary": "#93c5fd", "--primary-hover": "#60a5fa", "--primary-light": "rgba(147,197,253,0.12)",
      "--text": "#e0eeff", "--text-2": "#8aa8d8", "--text-3": "#5878a8",
      "--chart-2": "#86efac",
      "--shadow": "0 2px 12px rgba(0,0,0,0.4)",
    },
  },
  slate: {
    label: "Slate",
    bg2: "#28303c", primary: "#60a5fa", labelColor: "#507090",
    vars: {
      "--bg": "#1e2530", "--bg-2": "#28303c", "--bg-3": "#323c48",
      "--border": "#424e5e", "--border-2": "#546078",
      "--primary": "#60a5fa", "--primary-hover": "#3b82f6", "--primary-light": "rgba(96,165,250,0.12)",
      "--text": "#e0e8f4", "--text-2": "#90a0b8", "--text-3": "#607080",
      "--chart-2": "#f97316",
      "--shadow": "0 2px 12px rgba(0,0,0,0.3)",
    },
  },
  desert: {
    label: "Desert",
    bg2: "#5a4c35", primary: "#e8c44a", labelColor: "#988040",
    vars: {
      "--bg": "#4a3c28", "--bg-2": "#5a4c35", "--bg-3": "#6a5c42",
      "--border": "#806848", "--border-2": "#9a7c58",
      "--primary": "#e8c44a", "--primary-hover": "#c8a428", "--primary-light": "rgba(232,196,74,0.12)",
      "--text": "#fff8e0", "--text-2": "#d8b870", "--text-3": "#a88840",
      "--chart-2": "#7986cb",
      "--shadow": "0 2px 12px rgba(0,0,0,0.4)",
    },
  },

  // ── Light ────────────────────────────────────────────────────

  sage: {
    label: "Sage",
    bg2: "#f0f7ee", primary: "#166534", labelColor: "#4a6848",
    vars: {
      "--bg": "#e8f0e6", "--bg-2": "#f0f7ee", "--bg-3": "#dce8da",
      "--border": "#b8d0b4", "--border-2": "#98b894",
      "--primary": "#166534", "--primary-hover": "#14532d", "--primary-light": "rgba(22,101,52,0.10)",
      "--text": "#1a2a18", "--text-2": "#4a6448", "--text-3": "#6a8468",
      "--chart-2": "#c2410c",
      "--shadow": "0 2px 12px rgba(0,0,0,0.10)",
    },
  },
  parchment: {
    label: "Parchment",
    bg2: "#fdf6ec", primary: "#b45309", labelColor: "#8a6040",
    vars: {
      "--bg": "#f4ede0", "--bg-2": "#fdf6ec", "--bg-3": "#ebe0cc",
      "--border": "#d8c8a8", "--border-2": "#c0a880",
      "--primary": "#b45309", "--primary-hover": "#92400e", "--primary-light": "rgba(180,83,9,0.10)",
      "--text": "#2a1e08", "--text-2": "#6a5030", "--text-3": "#9a7850",
      "--chart-2": "#1d4ed8",
      "--shadow": "0 2px 12px rgba(0,0,0,0.10)",
    },
  },
  paper: {
    label: "Paper",
    bg2: "#f8fafd", primary: "#4f46e5", labelColor: "#6070a0",
    vars: {
      "--bg": "#eef2f8", "--bg-2": "#f8fafd", "--bg-3": "#e2e8f4",
      "--border": "#c8d4e8", "--border-2": "#a8b8d8",
      "--primary": "#4f46e5", "--primary-hover": "#3730a3", "--primary-light": "rgba(79,70,229,0.10)",
      "--text": "#1a1f38", "--text-2": "#4a5580", "--text-3": "#7080a8",
      "--chart-2": "#0891b2",
      "--shadow": "0 2px 12px rgba(0,0,0,0.08)",
    },
  },
  ice: {
    label: "Ice",
    bg2: "#f4fbff", primary: "#0369a1", labelColor: "#3a6888",
    vars: {
      "--bg": "#e8f4ff", "--bg-2": "#f4fbff", "--bg-3": "#d8ecfa",
      "--border": "#a8d0ee", "--border-2": "#80b8e8",
      "--primary": "#0369a1", "--primary-hover": "#025782", "--primary-light": "rgba(3,105,161,0.10)",
      "--text": "#0a1828", "--text-2": "#2c5878", "--text-3": "#507898",
      "--chart-2": "#c2410c",
      "--shadow": "0 2px 12px rgba(0,0,0,0.08)",
    },
  },
  coral: {
    label: "Coral",
    bg2: "#fff8f6", primary: "#c2410c", labelColor: "#904030",
    vars: {
      "--bg": "#fff0ec", "--bg-2": "#fff8f6", "--bg-3": "#ffe8e0",
      "--border": "#f0c8bc", "--border-2": "#e0a898",
      "--primary": "#c2410c", "--primary-hover": "#9a3408", "--primary-light": "rgba(194,65,12,0.10)",
      "--text": "#1a0a06", "--text-2": "#6a3020", "--text-3": "#9a5040",
      "--chart-2": "#1d4ed8",
      "--shadow": "0 2px 12px rgba(0,0,0,0.10)",
    },
  },
  rose: {
    label: "Rose",
    bg2: "#fff8fa", primary: "#be185d", labelColor: "#904060",
    vars: {
      "--bg": "#fef2f5", "--bg-2": "#fff8fa", "--bg-3": "#f5e8ee",
      "--border": "#e8c0cc", "--border-2": "#d8a0b0",
      "--primary": "#be185d", "--primary-hover": "#9d1554", "--primary-light": "rgba(190,24,93,0.10)",
      "--text": "#1a0810", "--text-2": "#6a3040", "--text-3": "#9a5868",
      "--chart-2": "#1d4ed8",
      "--shadow": "0 2px 12px rgba(0,0,0,0.10)",
    },
  },
  cotton_candy: {
    label: "Cotton Candy",
    bg2: "#fff8fe", primary: "#9333ea", labelColor: "#7048b0",
    vars: {
      "--bg": "#fdf4ff", "--bg-2": "#fff8fe", "--bg-3": "#f5e8ff",
      "--border": "#e8d0f4", "--border-2": "#d8b8ec",
      "--primary": "#9333ea", "--primary-hover": "#7e22ce", "--primary-light": "rgba(147,51,234,0.10)",
      "--text": "#1a0828", "--text-2": "#6040a0", "--text-3": "#8060c0",
      "--chart-2": "#0891b2",
      "--shadow": "0 2px 12px rgba(0,0,0,0.10)",
    },
  },
};

function applyTheme(name) {
  const theme = THEMES[name] || THEMES.midnight;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, v);
  }
}

// Apply cached theme immediately to prevent flash on load
(function () {
  const cached = localStorage.getItem("cc_theme");
  if (cached && THEMES[cached]) applyTheme(cached);
})();
