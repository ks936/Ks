"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "dist");

const files = [
  "index.html",
  "styles.css",
  "app.js",
  "manifest.json",
  "sw.js",
  "studyos_wep_jee_advanced_50.json",
  "library/jee-class11.js",
  "library/physics-chapter-notes.js"
];

fs.mkdirSync(OUTPUT, { recursive: true });

for (const relativePath of files) {
  const source = path.join(ROOT, relativePath);
  if (!fs.existsSync(source)) continue;

  const destination = path.join(OUTPUT, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
