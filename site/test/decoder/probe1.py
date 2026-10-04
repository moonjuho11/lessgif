import sys; sys.path.insert(0, '.')
from gifwriter import *
D = 'probe/'
PAL = [(255,0,0),(0,255,0),(0,0,255),(255,255,0)]
def px(w,h,f): return [f(x,y) for y in range(h) for x in range(w)]
# delays
g = Gif(4,2,PAL); g.loop(0)
for d in (0,1,2,5,10,65535):
    g.gce(delay=d); g.image(0,0,4,2,px(4,2,lambda x,y:(x+y+d)%4))
g.trailer().save(D+'delays.gif')
# out of range index, opaque full frame 0 (palette of 2 entries), and frame 1 opaque partial over it
P2 = [(255,0,0),(0,255,0)]
g = Gif(4,4,P2, gct_bits=0)
g.gce(delay=10); g.image(0,0,4,4,px(4,4,lambda x,y: 3 if x==y else 1), mcs=2)
g.gce(delay=10); g.image(1,1,2,2,[0,3,3,0], mcs=2)
g.gce(delay=10); g.image(0,0,4,4,px(4,4,lambda x,y: 2 if x==1 else 0), mcs=2)
g.trailer().save(D+'oob_index.gif')
# same but with a transparent index on frame 0 (so frame 0 hasAlpha)
g = Gif(4,4,P2, gct_bits=0)
g.gce(delay=10, trans=0); g.image(0,0,4,4,px(4,4,lambda x,y: 3 if x==y else 1), mcs=2)
g.gce(delay=10); g.image(0,0,4,4,px(4,4,lambda x,y: 2 if x==1 else 0), mcs=2)
g.trailer().save(D+'oob_index_t.gif')
# transparent index >= palette size
g = Gif(4,4,P2, gct_bits=0)
g.gce(delay=10); g.image(0,0,4,4,px(4,4,lambda x,y: 1),mcs=2)
g.gce(delay=10, trans=3); g.image(0,0,4,4,px(4,4,lambda x,y: 3 if y<2 else 0), mcs=2)
g.trailer().save(D+'trans_oob.gif')
# short data, block terminator present, frame 0 independent full
idx = px(8,8,lambda x,y:(x//2+y)%4)
full = lzw(idx, 2)
g = Gif(8,8,PAL); g.gce(delay=10); g.image(0,0,8,8,lzw_data=lzw(idx[:20],2,end_code=False), mcs=2)
g.gce(delay=10); g.image(0,0,8,8,idx[::-1]); g.trailer().save(D+'short0.gif')
# short data in frame 1 (independent opaque full)
g = Gif(8,8,PAL); g.gce(delay=10); g.image(0,0,8,8,idx)
g.gce(delay=10); g.image(0,0,8,8,lzw_data=lzw([3]*20,2,end_code=False), mcs=2)
g.gce(delay=10); g.image(0,0,8,8,idx[::-1]); g.trailer().save(D+'short1.gif')
# short data in frame 1 (dependent: transparent index)
g = Gif(8,8,PAL); g.gce(delay=10); g.image(0,0,8,8,idx)
g.gce(delay=10, trans=0); g.image(0,0,8,8,lzw_data=lzw([3]*20,2,end_code=False), mcs=2)
g.gce(delay=10); g.image(0,0,8,8,idx[::-1]); g.trailer().save(D+'short1t.gif')
# early EOI in frame 0, frame 1
g = Gif(8,8,PAL); g.gce(delay=10); g.image(0,0,8,8,lzw_data=lzw(idx[:20],2), mcs=2)
g.gce(delay=10); g.image(0,0,8,8,idx[::-1]); g.trailer().save(D+'eoi0.gif')
g = Gif(8,8,PAL); g.gce(delay=10); g.image(0,0,8,8,idx)
g.gce(delay=10, trans=0); g.image(0,0,8,8,lzw_data=lzw([3]*20,2), mcs=2)
g.gce(delay=10); g.image(0,0,8,8,idx[::-1]); g.trailer().save(D+'eoi1t.gif')
# truncated file mid-frame 1 (frame 0 complete) - cut inside LZW
b = Gif(8,8,PAL).gce(delay=10).image(0,0,8,8,idx).gce(delay=10, trans=0).image(0,0,8,8,[3]*64, block_size=4).bytes()
open(D+'trunc_mid1.gif','wb').write(b[:-6])
b0 = Gif(8,8,PAL).gce(delay=10).image(0,0,8,8,idx, block_size=3).bytes()
open(D+'trunc_mid0.gif','wb').write(b0[:-5])
# interlaced first frame truncated
idx16 = px(8,16,lambda x,y: y%4)
b = Gif(8,16,PAL).gce(delay=10).image(0,0,8,16,idx16, interlace=True, block_size=1).bytes()
open(D+'interlace_trunc.gif','wb').write(b[:len(b)-12])
Gif(8,16,PAL).gce(delay=10).image(0,0,8,16,idx16, interlace=True).trailer().save(D+'interlace_ok.gif')
