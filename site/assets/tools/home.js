// Home page: a file dropped here goes to the tool that fits it.
import { $, dropZone, errorBox, openIn } from '../app.js';
import { sniff } from '../load.js';

const err = errorBox();
const drop = dropZone(
  { accept: 'image/*,video/*,.gif,.mp4,.webm,.mov', multiple: true, title: 'Drop a video, a GIF or images', hint: 'A video becomes a GIF, a GIF opens in the compressor, and several images become an animation.' },
  async (files) => {
    err.hide();
    const kinds = await Promise.all(files.map(sniff));
    if (kinds.some((k) => !k)) return err.show("Some of those files aren't videos or images this site can read.");
    const list = files.map((f) => ({ blob: f, name: f.name || 'file' }));
    if (files.length > 1) {
      if (kinds.includes('video')) return err.show('Drop one video at a time.');
      return openIn('maker', list);
    }
    const k = kinds[0];
    openIn(k === 'video' ? 'video-to-gif' : k === 'image' ? 'maker' : 'compress', list);
  },
);
$('#tool').append(drop, err.el);
