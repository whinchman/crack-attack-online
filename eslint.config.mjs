import { globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default tseslint.config(
  globalIgnores(["dist-pages/**", "build/**", "node_modules/**"]),
  {
    files: ["app/**/*.ts", "app/**/*.tsx", "relay/**/*.ts", "tests/**/*.ts"],
    extends: [tseslint.configs.recommended],
  },
);
