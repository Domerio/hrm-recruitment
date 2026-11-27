// Recognize one fixed public UI asset by all 4096 decoded RGBA bytes. This
// reads only a private 32 x 32 copy of the supplied drawImage source, never the
// resume bitmap, and grants no permission to ignore the image or click it.
// Official asset: https://img.bosszhipin.com/static/zhipin/recommend-wasm/958791963567135086.png
// Chromium sRGB RGBA SHA-256: 8fb554f0120d7eca61bc9dbd2b0deb656873648e650c3d5b8910e7444c599766
(() => {
  if(window.__hrmCanvasPlatformAssets?.version===1)return;
  const Canvas=globalThis.OffscreenCanvas,proto=globalThis.OffscreenCanvasRenderingContext2D?.prototype;
  const native={getContext:Canvas?.prototype?.getContext};
  for(const name of ['drawImage','getImageData','getContextAttributes'])native[name]=proto?.[name];
  const palette=[
    [0,0,0,0],
    [255,120,72,64],
    [255,120,71,144],
    [255,121,71,207],
    [255,121,71,239],
    [255,120,71,255],
    [255,120,72,191],
    [255,120,72,96],
    [255,120,71,223],
    [255,120,72,32],
    [255,120,71,159],
    [255,121,71,175],
    [255,120,71,191],
    [255,121,71,143],
    [255,121,70,80],
    [255,120,70,127],
    [255,120,72,128],
    [255,121,73,80],
    [255,120,72,159],
    [255,120,72,160],
    [255,120,71,176],
    [255,128,64,16],
    [255,121,72,95],
    [255,121,70,95]
  ];
  const rows=[
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAABCDEFFEGCBAAAAAAAAAAA',
    'AAAAAAAAAHIFFFFFFFFFFIHAAAAAAAAA',
    'AAAAAAAJDFFFFEDKLMEFFFFIJAAAAAAA',
    'AAAAAAHEFFENBAAAAAABKFFFEOAAAAAA',
    'AAAAAOFFFMJAAAAAAAAAAJLFFFHAAAAA',
    'AAAAJEFFPAAAAAAAAAAAAAAPFFEJAAAA',
    'AAAAIFFPAAAAAAAAAAAAAAAAPFFDAAAA',
    'AAAHFFLAAAAAAAAQQAAAAAAAAMFFHAAA',
    'AAAIFFJAAAAAAARFFHAAAAAAAJEFIAAA',
    'AABFFKAAAAAAAAHFFHAAAAAAAACFFBAA',
    'AACFFBAAAAAAAAHFFHAAAAAAAABFFCAA',
    'AAGFEAAAAAAAAAHFFHAAAAAAAAAEFDAA',
    'AAEFMAAAAAAAAAHFFHAAAAAAAAADFEAA',
    'AAFFLAAAAAAAAAHFFHAAAAAAAAASFFAA',
    'AAFFTAAAAAAAAAHFFHAAAAAAAAAUFFAA',
    'AAEFDAAAAAAAAAHFFOAAAAAAAAAGFEAA',
    'AADFEAAAAAAAAAAPPAAAAAAAAAAEFMAA',
    'AACFFBAAAAAAAAAAAAAAAAAAAABFFCAA',
    'AABFFCAAAAAAAAJIIVAAAAAAAASFFBAA',
    'AAAIFEJAAAAAAARFFOAAAAAAAJFFIAAA',
    'AAAHFFMAAAAAAAAPPAAAAAAAALFFHAAA',
    'AAAADFFQAAAAAAAAAAAAAAAAQFFIAAAA',
    'AAAAJEFFQAAAAAAAAAAAAAAQFFEJAAAA',
    'AAAAAWFFFLJAAAAAAAAAAJGFFFOAAAAA',
    'AAAAAAOEFFFTBAAAAAABCEFFEXAAAAAA',
    'AAAAAAAJIFFFFEGLSDEFFFFDJAAAAAAA',
    'AAAAAAAAAHIFFFFFFFFFFIHAAAAAAAAA',
    'AAAAAAAAAAABNMEFFEDNBAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  ];
  let stopped=false;
  const call=(name,receiver,args)=>Reflect.apply(native[name],receiver,args);
  function dimensions(source){
    // A not-yet-loaded HTMLImageElement must not fall back to its CSS width.
    const natural=source?.naturalWidth!==undefined||source?.naturalHeight!==undefined;
    return natural?[source.naturalWidth,source.naturalHeight]:[source?.width,source?.height];
  }
  window.__hrmCanvasPlatformAssets={
    version:1,
    match(source){
      let canvas;
      try{
        if(stopped||typeof Canvas!=='function'||Object.values(native).some(fn=>typeof fn!=='function'))return '';
        const size=dimensions(source);
        if(size[0]!==32||size[1]!==32)return '';
        // A fresh surface prevents a tainted/closed/failed source from reusing
        // pixels of a preceding match. Mutable source elements are never cached.
        canvas=new Canvas(32,32);
        const ctx=call('getContext',canvas,['2d',{alpha:true,colorSpace:'srgb',willReadFrequently:true}]);
        if(!ctx)return '';
        const attributes=call('getContextAttributes',ctx,[]);
        if(attributes?.alpha!==true||attributes.colorSpace!=='srgb'||
          attributes.colorType!==undefined&&attributes.colorType!=='unorm8')return '';
        call('drawImage',ctx,[source,0,0]);
        const actual=call('getImageData',ctx,[0,0,32,32]);
        if(actual?.width!==32||actual.height!==32||actual.data?.length!==4096)return '';
        const after=dimensions(source);
        if(after[0]!==32||after[1]!==32)return '';
        for(let y=0;y<32;y++)for(let x=0;x<32;x++){
          const expected=palette[rows[y].charCodeAt(x)-65],offset=(y*32+x)*4;
          for(let channel=0;channel<4;channel++)if(actual.data[offset+channel]!==expected[channel])return '';
        }
        return 'experience-inquiry';
      }catch{return '';}
      finally{try{if(canvas){canvas.width=0;canvas.height=0;}}catch{}}
    },
    stop(){
      stopped=true;
      if(window.__hrmCanvasPlatformAssets===this)delete window.__hrmCanvasPlatformAssets;
    },
  };
})();
