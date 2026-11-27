// Conservative geometry for one observed Canvas path. Coordinates are captured
// with each command; unknown paths are never replaced by their bounding box.
(() => {
  if (window.__hrmCanvasGeometry?.version === 1) return;
  const tau = Math.PI * 2;
  const finite = values => Array.from(values).every(Number.isFinite);
  const point = (x,y) => ({x,y});
  const same = (a,b) => a.x === b.x && a.y === b.y;
  const validBounds = r => r && finite([r.left,r.top,r.right,r.bottom]) && r.left < r.right && r.top < r.bottom;
  const contains = (a,b) => a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
  const axis = (a,b) => a.x === b.x && a.y !== b.y ? point(0,Math.sign(b.y-a.y)) :
    a.y === b.y && a.x !== b.x ? point(Math.sign(b.x-a.x),0) : null;
  const boundsOf = points => ({left:Math.min(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),
    right:Math.max(...points.map(p=>p.x)),bottom:Math.max(...points.map(p=>p.y))});
  const cornerIndex = (p,b) => p.x === b.left ? p.y === b.top ? 0 : p.y === b.bottom ? 3 : -1 :
    p.x === b.right ? p.y === b.top ? 1 : p.y === b.bottom ? 2 : -1 : -1;
  const corners = b => [point(b.left,b.top),point(b.right,b.top),point(b.right,b.bottom),point(b.left,b.bottom)];
  const numericArgs = (command,size) => command.args.length === size && finite(command.args);
  function normalizedRadii(value,width,height) {
    const values = Array.isArray(value) ? value : [value === undefined ? 0 : value];
    if (values.length < 1 || values.length > 4) return null;
    const input = values.map(radius => typeof radius === 'number' ? point(radius,radius) :
      radius && typeof radius === 'object' ? point(radius.x ?? 0,radius.y ?? 0) : null);
    if (input.some(r=>!r || !finite([r.x,r.y]) || r.x < 0 || r.y < 0)) return null;
    let radii = input.length === 1 ? [input[0],input[0],input[0],input[0]] :
      input.length === 2 ? [input[0],input[1],input[0],input[1]] :
      input.length === 3 ? [input[0],input[1],input[2],input[1]] : input;
    const sums = [radii[0].x+radii[1].x,radii[1].y+radii[2].y,radii[2].x+radii[3].x,radii[3].y+radii[0].y];
    if (!finite(sums)) return null;
    const scale = Math.min(1,...sums.map((sum,i)=>sum ? (i%2 ? height : width)/sum : 1));
    radii = radii.map(r=>point(r.x*scale,r.y*scale));
    return radii;
  }
  function primitive(command) {
    const a=command.args;
    if (command.name === 'rect' && numericArgs(command,4)) {
      const [x,y,width,height]=a;
      return {kind:'rect',bounds:{left:Math.min(x,x+width),top:Math.min(y,y+height),right:Math.max(x,x+width),bottom:Math.max(y,y+height)}};
    }
    if (command.name === 'roundRect' && (a.length === 4 || a.length === 5) && finite(a.slice(0,4))) {
      const [x,y,width,height]=a;
      // Negative dimensions have corner-flipping semantics; leave these
      // uncommon paths unsupported rather than guessing corner assignment.
      if (width <= 0 || height <= 0) return null;
      const radii=normalizedRadii(a[4],width,height);
      return radii && {kind:'roundRect',bounds:{left:x,top:y,right:x+width,bottom:y+height},radii};
    }
    if (command.name === 'arc' || command.name === 'ellipse') {
      const circle=command.name === 'arc',count=circle ? 5 : 7;
      if ((a.length !== count && a.length !== count+1) || !finite(a.slice(0,count)) ||
          (a.length > count && typeof a[count] !== 'boolean')) return null;
      const [cx,cy]=a,rx=a[2],ry=circle ? rx : a[3],rotation=circle ? 0 : a[4];
      const start=a[circle ? 3 : 5],end=a[circle ? 4 : 6],counterclockwise=a[count] === true;
      if (rx <= 0 || ry <= 0 || rotation !== 0 || (counterclockwise ? start-end : end-start) < tau) return null;
      return {kind:'ellipse',bounds:{left:cx-rx,top:cy-ry,right:cx+rx,bottom:cy+ry},cx,cy,rx,ry};
    }
    return null;
  }
  function polygon(commands,closed) {
    if (!commands.every((c,i)=>c.name === (i ? 'lineTo' : 'moveTo') && numericArgs(c,2))) return null;
    const points=commands.map(c=>point(...c.args));
    if (points.length > 1 && same(points.at(-1),points[0])) {points.pop();closed=true;}
    if (!closed || points.length !== 4) return null;
    const bounds=boundsOf(points),indices=points.map(p=>cornerIndex(p,bounds));
    if (!validBounds(bounds) || indices.includes(-1) || new Set(indices).size !== 4 ||
        points.some((p,i)=>!axis(p,points[(i+1)%4]))) return null;
    return {kind:'rect',bounds};
  }
  function roundedPath(commands,closed) {
    if (commands[0].name !== 'moveTo' || !numericArgs(commands[0],2)) return null;
    const start=point(...commands[0].args),arcs=[],lines=[];
    let current=start;
    const lineTo=end=>{if (!same(current,end)) lines.push({start:current,end});current=end;};
    for (const command of commands.slice(1)) {
      const a=command.args;
      if (command.name === 'lineTo' && numericArgs(command,2)) {lineTo(point(...a));continue;}
      if (command.name !== 'arcTo' || !numericArgs(command,5)) return null;
      const corner=point(a[0],a[1]),next=point(a[2],a[3]),radius=a[4];
      const incoming=axis(current,corner),outgoing=axis(corner,next);
      if (!(radius > 0) || !incoming || !outgoing || incoming.x*outgoing.x+incoming.y*outgoing.y !== 0) return null;
      // A large radius can make arcTo travel backwards or past its controls.
      // Those arcs are not a monotonic rounded-rectangle perimeter.
      if (Math.abs(current.x-corner.x)+Math.abs(current.y-corner.y) < radius ||
          Math.abs(next.x-corner.x)+Math.abs(next.y-corner.y) < radius) return null;
      const tangent=point(corner.x-incoming.x*radius,corner.y-incoming.y*radius);
      const end=point(corner.x+outgoing.x*radius,corner.y+outgoing.y*radius);
      lineTo(tangent);
      arcs.push({corner,incoming,outgoing,radius});current=end;
    }
    if (!closed && !same(current,start)) return null;
    lineTo(start);
    if (arcs.length !== 4) return null;
    const bounds=boundsOf(arcs.map(arc=>arc.corner));
    if (!validBounds(bounds)) return null;
    const indices=arcs.map(arc=>cornerIndex(arc.corner,bounds));
    if (indices.includes(-1) || new Set(indices).size !== 4) return null;
    const step=(indices[1]-indices[0]+4)%4;
    if (![1,3].includes(step) || indices.some((index,i)=>index !== (indices[0]+step*i)%4)) return null;
    const radii=Array(4);
    for (let i=0;i<4;i++) {
      const arc=arcs[i],prev=arcs[(i+3)%4].corner,next=arcs[(i+1)%4].corner;
      if (!same(arc.incoming,axis(prev,arc.corner)) || !same(arc.outgoing,axis(arc.corner,next))) return null;
      radii[indices[i]]=point(arc.radius,arc.radius);
    }
    const width=bounds.right-bounds.left,height=bounds.bottom-bounds.top;
    if (radii[0].x+radii[1].x > width || radii[2].x+radii[3].x > width ||
        radii[0].y+radii[3].y > height || radii[1].y+radii[2].y > height) return null;
    const clockwise=step === 1;
    for (const line of lines) {
      const a=line.start,b=line.end,direction=axis(a,b);
      if (!direction) return null;
      let minimum,maximum,from,to,forward;
      if (a.y === b.y && a.y === bounds.top) {
        minimum=bounds.left+radii[0].x;maximum=bounds.right-radii[1].x;from=a.x;to=b.x;forward=clockwise;
      } else if (a.x === b.x && a.x === bounds.right) {
        minimum=bounds.top+radii[1].y;maximum=bounds.bottom-radii[2].y;from=a.y;to=b.y;forward=clockwise;
      } else if (a.y === b.y && a.y === bounds.bottom) {
        minimum=bounds.left+radii[3].x;maximum=bounds.right-radii[2].x;from=a.x;to=b.x;forward=!clockwise;
      } else if (a.x === b.x && a.x === bounds.left) {
        minimum=bounds.top+radii[0].y;maximum=bounds.bottom-radii[3].y;from=a.y;to=b.y;forward=!clockwise;
      } else return null;
      if (Math.min(from,to) < minimum || Math.max(from,to) > maximum || (forward ? to <= from : to >= from)) return null;
    }
    return {kind:'roundRect',bounds,radii};
  }
  function transform(shape,matrix) {
    if (!shape || !validBounds(shape.bounds)) return null;
    const [sx,,,sy,tx,ty]=matrix,b=shape.bounds;
    const bounds={left:b.left*sx+tx,top:b.top*sy+ty,right:b.right*sx+tx,bottom:b.bottom*sy+ty};
    if (!validBounds(bounds)) return null;
    const result={kind:shape.kind,bounds:Object.freeze(bounds)};
    if (shape.radii) result.radii=Object.freeze(shape.radii.map(r=>Object.freeze(point(r.x*sx,r.y*sy))));
    if (shape.kind === 'ellipse') Object.assign(result,{cx:shape.cx*sx+tx,cy:shape.cy*sy+ty,rx:shape.rx*sx,ry:shape.ry*sy});
    return Object.freeze(result);
  }
  function analyze(commands) {
    try {
      if (!Array.isArray(commands) || !commands.length || commands.length > 64) return null;
      const matrix=commands[0]?.matrix;
      if (!Array.isArray(matrix) || matrix.length !== 6 || !finite(matrix) || matrix[1] !== 0 || matrix[2] !== 0 || matrix[0] <= 0 || matrix[3] <= 0) return null;
      if (commands.some(c=>!c || !Array.isArray(c.args) || !Array.isArray(c.matrix) || c.matrix.length !== 6 || !finite(c.matrix) ||
          c.matrix.some((value,i)=>value !== matrix[i]))) return null;
      let path=commands;
      if (path[0].name === 'beginPath' && !path[0].args.length) path=path.slice(1);
      let closed=false;
      while (path.at(-1)?.name === 'closePath' && !path.at(-1).args.length) {closed=true;path=path.slice(0,-1);}
      if (!path.length) return null;
      const shape=path.length === 1 ? primitive(path[0]) :
        path.some(c=>c.name === 'arcTo') ? roundedPath(path,closed) : polygon(path,closed);
      return transform(shape,matrix);
    } catch { return null; }
  }
  function rectInside(shape,rect) {
    try {
      if (!shape || !validBounds(shape.bounds) || !validBounds(rect) || !contains(shape.bounds,rect)) return false;
      if (shape.kind === 'rect') return true;
      if (shape.kind === 'ellipse') {
        if (!finite([shape.cx,shape.cy,shape.rx,shape.ry]) || shape.rx <= 0 || shape.ry <= 0) return false;
        return corners(rect).every(p=>((p.x-shape.cx)/shape.rx)**2+((p.y-shape.cy)/shape.ry)**2 <= 1);
      }
      if (shape.kind !== 'roundRect' || !Array.isArray(shape.radii) || shape.radii.length !== 4 ||
          shape.radii.some(r=>!r || !finite([r.x,r.y]) || r.x < 0 || r.y < 0)) return false;
      const b=shape.bounds;
      return corners(rect).every(p=>shape.radii.every((r,i)=>{
        if (!r.x || !r.y) return true;
        const left=i === 0 || i === 3,top=i < 2;
        const cx=left ? b.left+r.x : b.right-r.x,cy=top ? b.top+r.y : b.bottom-r.y;
        if ((left ? p.x >= cx : p.x <= cx) || (top ? p.y >= cy : p.y <= cy)) return true;
        return ((p.x-cx)/r.x)**2+((p.y-cy)/r.y)**2 <= 1;
      }));
    } catch { return false; }
  }
  function intersectsBounds(a,b) {
    // Unknown bounds cannot prove that two painted regions are disjoint.
    try {
      if (!validBounds(a) || !validBounds(b)) return true;
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    } catch { return true; }
  }
  window.__hrmCanvasGeometry=Object.freeze({version:1,analyze,rectInside,intersectsBounds});
})();
