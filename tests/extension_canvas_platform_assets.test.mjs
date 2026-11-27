import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const script=fs.readFileSync(new URL('../extension/canvas-platform-assets.js',import.meta.url),'utf8');
// Independent fixture: decoded bytes from the public 32 x 32 PNG, compressed
// for this test only. The production matcher uses an exact palette/pixel map.
const official=new Uint8ClampedArray(inflateSync(Buffer.from('eNrtV91xhCAQvhJSgqX4pOTtOriUoU93HcQOvA5MB5RgCZaQEgiCOC4/yy6JM3k4ZhgdAZfd/fj49nJ5NWpTnahV1w6qb2fdv/W7Mt28C2nG9JwT7H7ofy+7vXxf1jV/YLcyvvr/X/2130f9nPRTgnjAfVTFPvsx7ttPLL5bfsZwr82VZVvP9/yQHD+2uE3wH7R8bGsPsWzu5flr7h5Gq/yaI87KbSf2MBNw7uZOhFg91k7wSVLyAH3HY6X69ys1t15OFwS7Di8jkRPI2LLctM+vueO/tw/8GyLj0uGUwYm8s+VyEMHhIT/yRPtzykcO7ovtd2LnxqT9TjzPs99+Je0juclzBY3fMYxhucG5jc6RGMa4569Qu2DnDx2Pcprly0U96jcO9lL+7fxLuKsA/2byv+1VYfwbYjrPA9T8Qy2QuSuA3srfbbQ7Mu97Wn+U7wHYJuoPGwNx8zTcxNZf7qwzOQJowEDTiidBfw6hbm1uxfo7pvtdvWHjMgb1yEFvlerv/1B/RONragCv3nD1SKY+eLWw/QBOyRu0','base64')));
assert.equal(createHash('sha256').update(official).digest('hex'),
  '8fb554f0120d7eca61bc9dbd2b0deb656873648e650c3d5b8910e7444c599766');
const source=(pixels=official)=>({naturalWidth:32,naturalHeight:32,pixels:new Uint8ClampedArray(pixels)});

function fixture(options={}){
  const calls={construct:0,draw:0,read:0,disposed:0},surfaces=[];
  class Context {
    constructor(canvas,settings){this.canvas=canvas;this.settings=settings;}
    getContextAttributes(){return {...this.settings,colorType:'unorm8',...options.attributes};}
    drawImage(image,x,y){
      calls.draw++;assert.equal(x,0);assert.equal(y,0);
      if(image.closed||options.drawThrows)throw Error('invalid private source');
      this.tainted=image.tainted;
      this.data=new Uint8ClampedArray(image.pixels);
      options.afterDraw?.(image);
    }
    getImageData(x,y,width,height){
      calls.read++;assert.deepEqual([x,y,width,height],[0,0,32,32]);
      if(this.tainted||options.readThrows)throw Error('private cross-origin pixels');
      return {width:options.readWidth??32,height:32,data:options.readData??this.data};
    }
  }
  class Canvas {
    constructor(width,height){
      calls.construct++;assert.equal(width,32);assert.equal(height,32);
      if(options.constructThrows)throw Error('unavailable');
      this._width=width;this._height=height;surfaces.push(this);
    }
    get width(){return this._width;}set width(value){if(value===0)calls.disposed++;this._width=value;}
    get height(){return this._height;}set height(value){this._height=value;}
    getContext(type,settings){assert.equal(type,'2d');return options.noContext?null:new Context(this,settings);}
  }
  const window={},sandbox={window,OffscreenCanvas:Canvas,OffscreenCanvasRenderingContext2D:Context};
  if(options.noCanvas)delete sandbox.OffscreenCanvas;
  if(options.noPrototype)delete sandbox.OffscreenCanvasRenderingContext2D;
  if(options.missingMethod)delete Context.prototype[options.missingMethod];
  vm.createContext(sandbox);vm.runInContext(script,sandbox);
  return {api:window.__hrmCanvasPlatformAssets,window,calls,surfaces,Canvas,Context,
    reinstall:()=>vm.runInContext(script,sandbox)};
}

test('only the exact public 32 x 32 asset matches without retaining source data',()=>{
  const f=fixture();assert.equal(f.api.match(source()),'experience-inquiry');
  assert.equal(f.api.match({width:32,height:32,pixels:official}),'experience-inquiry');
  assert.deepEqual(f.calls,{construct:2,draw:2,read:2,disposed:2});
  assert.ok(f.surfaces.every(canvas=>canvas.width===0&&canvas.height===0));
  assert.deepEqual(Object.keys(f.api).sort(),['match','stop','version']);
});

test('every individual channel mutation is rejected, including transparent RGB and alpha',()=>{
  const f=fixture(),image=source();
  for(let index=0;index<image.pixels.length;index++){
    image.pixels[index]^=1;
    assert.equal(f.api.match(image),'',`channel ${index}`);
    image.pixels[index]^=1;
  }
  assert.equal(f.api.match(image),'experience-inquiry');
  assert.equal(f.calls.construct,f.calls.disposed);
});

test('an image element is re-read after its source pixels change',()=>{
  const f=fixture(),image=source();assert.equal(f.api.match(image),'experience-inquiry');
  image.pixels.fill(0);assert.equal(f.api.match(image),'');
  image.pixels=new Uint8ClampedArray(official);assert.equal(f.api.match(image),'experience-inquiry');
  assert.equal(f.calls.read,3);
});

test('wrong, unloaded, spoofed CSS and changing dimensions do not match',()=>{
  const f=fixture();
  for(const fields of [
    {naturalWidth:0,naturalHeight:0,width:32,height:32},
    {naturalWidth:64,naturalHeight:32}, {naturalWidth:32,naturalHeight:64},
    {naturalWidth:'32',naturalHeight:32}, {naturalWidth:32,naturalHeight:undefined},
    {naturalWidth:undefined,naturalHeight:undefined,width:31,height:32},
  ])assert.equal(f.api.match({...source(),...fields}),'');
  assert.equal(f.calls.construct,0);
  const changed=fixture({afterDraw:image=>{image.naturalWidth=64;}});
  assert.equal(changed.api.match(source()),'');assert.equal(changed.calls.disposed,1);
});

test('failed or tainted sources cannot reuse preceding recognized pixels',()=>{
  const f=fixture();assert.equal(f.api.match(source()),'experience-inquiry');
  assert.equal(f.api.match({...source(),tainted:true}),'');
  assert.equal(f.api.match({...source(),closed:true}),'');
  assert.equal(f.api.match(source()),'experience-inquiry');
  assert.equal(f.calls.construct,4);assert.equal(f.calls.disposed,4);
});

test('unsupported contexts and native failures return no match without throwing',()=>{
  for(const options of [
    {noCanvas:true},{noPrototype:true},{missingMethod:'drawImage'},{missingMethod:'getImageData'},
    {missingMethod:'getContextAttributes'},{constructThrows:true},{drawThrows:true},{readThrows:true},
    {noContext:true},{attributes:{alpha:false}},{attributes:{colorSpace:'display-p3'}},
    {attributes:{colorType:'float16'}},{readWidth:31},{readData:new Uint8ClampedArray(4095)},
  ]){
    const f=fixture(options);assert.equal(f.api.match(source()),'',JSON.stringify(options));
    if(!options.constructThrows)assert.equal(f.calls.construct,f.calls.disposed);
  }
  const f=fixture();assert.equal(f.api.match(null),'');
  assert.equal(f.api.match({get naturalWidth(){throw Error('private');}}),'');
});

test('captured native methods survive later page prototype wrappers',()=>{
  const f=fixture();
  for(const name of ['drawImage','getImageData','getContextAttributes'])
    f.Context.prototype[name]=()=>{throw Error('page wrapper must not run');};
  f.Canvas.prototype.getContext=()=>{throw Error('page wrapper must not run');};
  assert.equal(f.api.match(source()),'experience-inquiry');
});

test('installation is idempotent and stopped handles cannot match',()=>{
  const f=fixture(),api=f.api;f.reinstall();assert.equal(f.window.__hrmCanvasPlatformAssets,api);
  api.stop();assert.equal(f.window.__hrmCanvasPlatformAssets,undefined);
  assert.equal(api.match(source()),'');assert.equal(f.calls.construct,0);
  f.reinstall();assert.notEqual(f.window.__hrmCanvasPlatformAssets,api);
  assert.equal(f.window.__hrmCanvasPlatformAssets.match(source()),'experience-inquiry');
  api.stop();assert.notEqual(f.window.__hrmCanvasPlatformAssets,undefined);
});
