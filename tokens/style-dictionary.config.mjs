// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { register } from '@tokens-studio/sd-transforms';
import StyleDictionary from 'style-dictionary';
import multiModeCss from './multi-mode-css.mjs';

// Register Tokens Studio transforms (color, dimension, fontWeight, etc.)
register(StyleDictionary);

// Register our custom format for single-file multi-mode CSS output
StyleDictionary.registerFormat(multiModeCss);

export default {
  source: [
    'tokens/global.json',
    'tokens/components/*.json',
  ],
  preprocessors: ['tokens-studio'],
  platforms: {
    css: {
      transformGroup: 'tokens-studio',
      buildPath: 'src/styles/',
      files: [
        {
          destination: 'tokens.css',
          format: 'custom/multi-mode-css',
        },
      ],
    },
  },
};
