import aiui from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
export default defineConfig({ plugins: [aiui(), solid()] });
