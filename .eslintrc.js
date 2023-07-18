module.exports = {
  env: {
    es2022: true,
    commonjs: true,
    "nova/nova": true,
  },

  extends: "eslint:recommended",
  plugins: ["nova"],

  rules: {
    "no-var": "error",
    "no-regex-spaces": "error",
    "prefer-const": "error"
  },
};
