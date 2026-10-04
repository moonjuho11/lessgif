import { gifTool } from '../app.js';

gifTool({
  current: 'reverse',
  verb: 'Reverse',
  suffix: '-reversed',
  quality: 100,
  ops(ui) {
    return [{ type: 'reverse', boomerang: ui.$('[name=mode]:checked').value === 'boomerang' }];
  },
});
