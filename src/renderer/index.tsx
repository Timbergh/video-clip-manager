import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

console.log(
  "%cVideo Clip Manager",
  "font-size: 24px; font-weight: bold; color: #fff;"
);
const version = (window as any).api?.getVersion?.();
console.log(`%cVersion ${version}`, "font-size: 14px; color: #888;");

// Console command system
const consoleCommands = {
  clearCache: async () => {
    try {
      console.log("🧹 Clearing app cache...");
      const result = await window.api.clearCache();

      if (result.success) {
        console.log(
          `✅ Cache cleared successfully! Removed ${result.filesCleared} files.`
        );
        if (result.errors && result.errors.length > 0) {
          console.warn("⚠️ Some files could not be deleted:", result.errors);
        }
      } else {
        console.error("❌ Failed to clear cache");
      }
    } catch (error) {
      console.error("❌ Error clearing cache:", error);
    }
  },

  help: () => {
    console.log(
      `
%cVideo Clip Manager Console Commands:
%cAvailable commands:
  clearCache() - Clear all app caches (thumbnails, metadata, audio)
  help() - Show this help message

%cUsage: Type the command name followed by parentheses in the console.
%cExample: clearCache()
    `,
      "font-weight: bold; color: #fff;",
      "color: #4CAF50;",
      "color: #FFC107;",
      "color: #2196F3;"
    );
  },
};

// Expose commands to global scope
(window as any).vcm = consoleCommands;

// Show help on load
console.log(
  "%cType vcm.help() for available commands",
  "color: #888; font-style: italic;"
);

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
