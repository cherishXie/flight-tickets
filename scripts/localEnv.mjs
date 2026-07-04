import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export function loadLocalEnv() {
  [".env.local", ".env"].forEach((fileName) => {
    const filePath = resolve(fileName);
    if (!existsSync(filePath)) return;
    readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .forEach((line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) return;
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
        if (key && process.env[key] === undefined) {
          process.env[key] = value;
        }
      });
  });
}
