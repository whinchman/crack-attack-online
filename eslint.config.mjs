import { defineConfig, globalIgnores } from "eslint/config";

const eslintConfig = defineConfig([
  globalIgnores(["dist-pages/**", "build/**", "node_modules/**"]),
]);

export default eslintConfig;
