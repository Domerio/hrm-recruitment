(() => {
  if (location.protocol !== 'https:' || !['www.zhipin.com', 'zhipin.com'].includes(location.hostname)
      || !/^\/web\/frame\/c-resume\/?$/.test(location.pathname)) return;
  if (window.__hrmExpandMarks?.version === 2) return;
  window.__hrmExpandMarks?.stop?.();
  const proto = globalThis.CanvasRenderingContext2D?.prototype;
  if (!proto) return;
  const labels = ['查看全部', '展开全部', '查看更多'];
  const subjects = ['个人优势','个人简介','期望职位','工作经历','工作经验','项目经历','项目经验','教育经历','教育背景',
    '资格证书','专业技能','所获荣誉','荣誉奖项','获奖经历','荣誉','语言能力'];
  const drawings = new WeakMap();
  const originals = new Map();
  let nextMarkId = 1;

  function labelState(word) {
    for (const label of labels) {
      if (label.startsWith(word)) return {complete:label===word};
      if (!word.startsWith(label)) continue;
      let suffix = word.slice(label.length);
      const count = suffix.match(/^[1-9]\d{0,3}/)?.[0];
      if (count) {
        suffix = suffix.slice(count.length);
        if (/^\d/.test(suffix)) continue;
        if (/^[个项条段份]/.test(suffix)) suffix = suffix.slice(1);
        if (!suffix) return {complete:false};
      } else if (/^\d/.test(suffix)) continue;
      if (subjects.some(subject=>subject.startsWith(suffix))) return {complete:subjects.includes(suffix)};
    }
    return null;
  }

  function state(canvas) {
    let drawing = drawings.get(canvas);
    if (!drawing || drawing.width !== canvas.width || drawing.height !== canvas.height) {
      drawing = {width:canvas.width, height:canvas.height, marks:[], fragment:null};
      drawings.set(canvas,drawing);
    }
    return drawing;
  }

  function bounds(ctx, left, top, right, bottom) {
    const matrix = ctx.getTransform();
    if (matrix.b || matrix.c || matrix.a <= 0 || matrix.d <= 0) return null;
    return {left:matrix.a*left+matrix.e, top:matrix.d*top+matrix.f,
      right:matrix.a*right+matrix.e, bottom:matrix.d*bottom+matrix.f};
  }

  function noteText(ctx, [value,x,y,maxWidth]) {
    const drawing = state(ctx.canvas);
    const word = typeof value === 'string' ? value.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g,'') : '';
    if (!word || !ctx.globalAlpha) {
      drawing.fragment = null;
      return;
    }
    const m = ctx.measureText(value);
    if (maxWidth < m.width) return;
    const rect = bounds(ctx,x-m.actualBoundingBoxLeft,y-m.actualBoundingBoxAscent,
      x+m.actualBoundingBoxRight,y+m.actualBoundingBoxDescent);
    if (!rect || !Object.values(rect).every(Number.isFinite) || rect.right <= rect.left || rect.bottom <= rect.top) return;
    const fragment = drawing.fragment;
    let mark = {word,...rect};
    if (fragment && Math.abs(fragment.top-rect.top) <= 4 &&
        Math.abs(fragment.right-rect.left) <= 8 && labelState(fragment.word+word)) {
      mark = {word:fragment.word+word,left:fragment.left,right:rect.right,
        top:Math.min(fragment.top,rect.top),bottom:Math.max(fragment.bottom,rect.bottom)};
      drawing.marks = drawing.marks.filter(old=>!(mark.word.startsWith(old.word) &&
        Math.abs(old.left-mark.left)<3 && Math.abs(old.top-mark.top)<3));
    }
    const status = labelState(mark.word);
    drawing.fragment = status ? mark : null;
    if (!status?.complete) return;
    if (!drawing.marks.some(old => old.word === mark.word && Math.abs(old.left-mark.left) < 3 && Math.abs(old.top-mark.top) < 3)) {
      drawing.marks.push({...mark,id:nextMarkId++});
      if (drawing.marks.length > 32) drawing.marks.shift();
    }
  }

  function erase(ctx, [x,y,width,height], fullyCovered=false) {
    const drawing = drawings.get(ctx.canvas);
    if (!drawing) return;
    const rect = bounds(ctx,Math.min(x,x+width),Math.min(y,y+height),Math.max(x,x+width),Math.max(y,y+height));
    if (!rect) return;
    drawing.marks = drawing.marks.filter(mark => fullyCovered
      ? !(mark.left >= rect.left && mark.right <= rect.right && mark.top >= rect.top && mark.bottom <= rect.bottom)
      : mark.left >= rect.right || mark.right <= rect.left || mark.top >= rect.bottom || mark.bottom <= rect.top);
    drawing.fragment = null;
  }

  function wrap(name, observe) {
    const original = proto[name];
    if (typeof original !== 'function') return;
    const wrapped = function(...args) {
      const result = Reflect.apply(original,this,args);
      try { observe(this,args); } catch {}
      return result;
    };
    originals.set(name,{original,wrapped});
    proto[name] = wrapped;
  }

  wrap('fillText',noteText);
  wrap('strokeText',noteText);
  wrap('clearRect',erase);
  wrap('fillRect',(ctx,args) => {
    // A background repaint may erase a label without calling clearRect.
    if (ctx.globalAlpha === 1 && typeof ctx.fillStyle === 'string' && /^#[0-9a-f]{6}$/i.test(ctx.fillStyle)) erase(ctx,args,true);
  });
  wrap('reset',ctx => drawings.delete(ctx.canvas));

  window.__hrmExpandMarks = {
    version:2,
    read() {
      const canvases = [...document.querySelectorAll('canvas')].filter(canvas => {
        const rect = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
        return rect.width >= 250 && rect.height >= 150 && style.visibility === 'visible' && Number(style.opacity) > 0;
      });
      if (canvases.length !== 1) return [];
      const drawing = state(canvases[0]);
      return drawing.marks.map(mark => ({
        id:mark.id, label:mark.word, x:(mark.left+mark.right)/(2*drawing.width), y:(mark.top+mark.bottom)/(2*drawing.height)
      }));
    },
    stop() {
      for (const [name,{original,wrapped}] of originals) {
        if (proto[name] === wrapped) proto[name] = original;
      }
      delete window.__hrmExpandMarks;
    }
  };
})();
