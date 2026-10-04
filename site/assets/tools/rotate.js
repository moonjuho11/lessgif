import { gifTool } from '../app.js';

gifTool({
  current: 'rotate',
  verb: 'Rotate',
  suffix: '-rotated',
  quality: 100,
  ops(ui) {
    const deg = +ui.$('[name=deg]:checked').value;
    const h = ui.$('[name=fh]').checked;
    const v = ui.$('[name=fv]').checked;
    if (!deg && !h && !v) throw new Error('Choose a rotation or a flip first.');
    return [{ type: 'rotate', deg }, { type: 'flip', h, v }];
  },
});
