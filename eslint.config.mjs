// @ts-check
import { cfgFlags, lsStackEslintCfg } from '@ls-stack/eslint-cfg';

const { OFF } = cfgFlags;

export default lsStackEslintCfg({
  tsconfigRootDir: import.meta.dirname,
  extraRuleGroups: [
    {
      // the package entry re-exports the public API of each module
      files: ['src/main.ts'],
      rules: { '@ls-stack/no-reexport': OFF },
    },
  ],
});
