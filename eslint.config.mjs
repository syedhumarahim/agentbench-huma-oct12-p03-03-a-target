import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist/**", "artifacts/**", "state/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
);
