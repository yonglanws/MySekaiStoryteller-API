import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'

export default tseslint.config([
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/out-host',
      '**/.zcode',
      'apifile/**',
      'astrbot_plugin_msst/**',
      '.mimosa/**',
      'cache/**',
      'output/**',
      'native/**',
      'resources/**',
      'personas/**',
      'src/renderer/public/live2d.min.js',
      'src/renderer/public/live2dcubismcore.min.js'
    ]
  },
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // 测试/工具脚本为纯 JS，不强制 TS 风格的显式返回类型
    files: ['scripts/**/*.mjs', 'scripts/**/*.js', '*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // 测试桩常见空方法（如 noop logger），放开空函数规则
    files: ['scripts/**/*.test.mjs', 'scripts/**/*.test.js'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off'
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ]
    }
  }
])
