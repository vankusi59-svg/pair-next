import fs from "fs";

export interface EnvironmentInfo {
  type: string;
}

export function detectEnvironment(): EnvironmentInfo {
  if (fs.existsSync("/.dockerenv")) {
    return { type: "docker" };
  }
  return { type: process.platform };
}
