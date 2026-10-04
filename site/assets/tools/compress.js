import { gifTool } from '../app.js';

gifTool({
  current: 'compress',
  verb: 'Compress',
  suffix: '-small',
  quality: 70,
  sizeTarget: true,
  keepOriginal: true,
  ops(ui) {
    const every = +ui.$('[name=drop]:checked').value;
    return every > 1 ? [{ type: 'drop', every }] : [];
  },
});
