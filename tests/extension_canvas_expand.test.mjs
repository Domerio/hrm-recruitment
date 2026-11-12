import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function drawingFixture(){
  const canvas={width:1000,height:1000,getBoundingClientRect:()=>({width:500,height:500})};
  class Context {
    constructor(){this.canvas=canvas;this.globalAlpha=1;}
    fillText(){}
    strokeText(){}
    clearRect(){}
    fillRect(){}
    getTransform(){return {a:1,b:0,c:0,d:1,e:0,f:0};}
    measureText(value){return {width:value.length*10,actualBoundingBoxLeft:0,
      actualBoundingBoxRight:value.length*10,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2};}
  }
  const window={};
  const context={window,CanvasRenderingContext2D:Context,document:{querySelectorAll:()=>[canvas]},
    getComputedStyle:()=>({visibility:'visible',opacity:'1'}),
    location:{protocol:'https:',hostname:'www.zhipin.com',pathname:'/web/frame/c-resume/'}};
  vm.runInNewContext(fs.readFileSync(new URL('../extension/canvas-expand.js',import.meta.url),'utf8'),context);
  return {ctx:new Context(),marks:()=>window.__hrmExpandMarks.read(),stop:()=>window.__hrmExpandMarks.stop()};
}

test('canvas records a full dynamic honor fold label and its actual drawn width',()=>{
  for(const label of ['展开全部16个所获荣誉','展开全部 16 个所获荣誉','查看全部３项荣誉']){
    const f=drawingFixture();
    f.ctx.fillText(label,100,100);
    const marks=f.marks();
    assert.equal(marks.length,1);
    assert.equal(marks[0].label,label.normalize('NFKC').replace(/\s/g,''));
    assert.equal(marks[0].x,(100+label.length*5)/1000);
    f.stop();
  }
});

test('canvas joins adjacent character or token draws without retaining the shorter base mark',()=>{
  for(const parts of [['展','开','全','部','1','6','个','所','获','荣','誉'],['展开全部','16','个所获荣誉']]){
    const f=drawingFixture();
    let x=100;
    for(const part of parts){f.ctx.fillText(part,x,100);x+=part.length*10;}
    const marks=f.marks();
    assert.equal(marks.length,1);
    assert.equal(marks[0].label,'展开全部16个所获荣誉');
    f.ctx.clearRect(0,0,1000,1000);
    assert.equal(f.marks().length,0);
    f.stop();
  }
});

test('canvas does not turn arbitrary resume prose or incomplete counts into click marks',()=>{
  const f=drawingFixture();
  for(const label of ['展开测试方案','展开全部16项内部测试任务','查看全部未来发展规划','展开全部000个荣誉']){
    f.ctx.fillText(label,100,100);
  }
  assert.equal(f.marks().length,0);
  f.ctx.fillText('展开全部',100,200);
  f.ctx.fillText('16',140,200);
  assert.equal(f.marks().length,0);
  f.stop();
});
