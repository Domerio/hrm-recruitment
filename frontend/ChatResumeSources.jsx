import {useEffect,useId,useRef,useState} from 'react';
import {DownloadOutlined,FileTextOutlined,PaperClipOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Collapse,Tag,Typography} from 'antd';
import './chat-resume-sources.css';
import { isRuleRejected } from '../extension/evaluation-result.mjs';

const checkColors={'满足':'success','不满足':'error','信息不足':'warning'};
function archiveTime(value){
  const date=value?new Date(value):null;
  return date&&!Number.isNaN(date.getTime())?date.toLocaleString('zh-CN',{
    timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,
  }):'时间未记录';
}
function ResumeEvidence({value,label}){
  const [expanded,setExpanded]=useState(false),contentId=useId();
  const long=value.length>260||value.split(/\r?\n/).length>5;
  return <div className={`chat-resume-evidence${long&&!expanded?' is-collapsed':''}`}>
    <span className="chat-resume-evidence-label">{label}</span>
    <p id={contentId} className="chat-resume-evidence-text">{value}</p>
    {long&&<button type="button" className="chat-resume-evidence-toggle" aria-controls={contentId}
      aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起依据':'展开完整依据'}</button>}
  </div>;
}

export default function ChatResumeSources({sources=[],api,notify,onRefresh}){
  const [pending,setPending]=useState(null),[error,setError]=useState('');
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setPending(null);setError('');return()=>{generation.current++;};},[sources]);
  const evaluate=async source=>{
    if(pending!==null)return;
    const sequence=generation.current;
    setPending(source.id);setError('');
    try{
      const response=await api('/api/communications/resume',{conversation_id:source.conversation_id,resume_id:source.id,evaluate:true});
      const body=await response.json();
      if(body.resume?.id!==source.id||body.resume?.conversation_id!==source.conversation_id)
        throw Error('评估结果与当前简历来源不一致，请刷新记录核对。');
      if(generation.current===sequence)await onRefresh?.();
    }catch(failure){if(generation.current===sequence){setError(failure.message);notify?.(failure.message,true);}}
    finally{if(generation.current===sequence)setPending(null);}
  };
  if(!sources.length)return null;
  return <section className="chat-resume-sources" aria-label="已归档聊天简历">
    <div className="chat-resume-section-heading">
      <Typography.Title level={5}>已归档聊天简历</Typography.Title><span className="chat-resume-count">{sources.length}</span>
    </div>
    <Typography.Paragraph className="chat-resume-section-description" type="secondary">按来源保留原文和评估结果，已有档案的人工维护内容不会被覆盖。</Typography.Paragraph>
    {error&&<Alert type="error" showIcon title={error}/>}
    <Collapse className="chat-resume-source-list" bordered={false} expandIconPlacement="end" items={sources.map(source=>{
      const evaluation=source.evaluation;
      const ruleRejected=isRuleRejected(evaluation);
      const complete=source.evaluation_status==='complete';
      const attachment=source.source_kind==='attachment';
      const score=Number.isFinite(evaluation?.score)?evaluation.score:null;
      const checks=[...(Array.isArray(evaluation?.required_checks)?evaluation.required_checks:[]),
        ...(Array.isArray(evaluation?.checks)?evaluation.checks:[])].filter(item=>item&&typeof item==='object');
      const questions=Array.isArray(evaluation?.questions)?evaluation.questions:[];
      return {key:String(source.id),label:<div className="chat-resume-source-heading">
        <span className={`chat-resume-source-icon${attachment?' is-attachment':''}`} aria-hidden="true">
          {attachment?<PaperClipOutlined/>:<FileTextOutlined/>}
        </span>
        <div className="chat-resume-source-title"><strong>{source.name||'未命名候选人'}</strong>
          <span>{attachment?'附件简历':'在线简历'}<span className="chat-resume-heading-divider">·</span>原文版本 #{source.id}</span>
        </div>
        {ruleRejected?<Tag color="warning">规则预筛不达标 · 未调用模型</Tag>:score!==null?<span className="chat-resume-score" aria-label={`AI 匹配 ${score} 分`}>
          <span className="chat-resume-score-label">AI 匹配</span><span><strong>{score}</strong> 分</span>
        </span>:<Tag className="chat-resume-pending-tag" color={source.evaluation_status==='failed'?'warning':'default'}>
          {source.evaluation_status==='not_requested'?'未评估':'AI 待评估'}</Tag>}
      </div>,children:<div className="chat-resume-source-body">
        <div className="chat-resume-source-toolbar">
          <div className="chat-resume-source-meta"><time dateTime={source.created||undefined}>归档于 {archiveTime(source.created)}</time>
            <span>会话 {source.friend_id||source.conversation_id}</span></div>
          <div className="chat-resume-source-actions">
            {source.attachment_id&&<Button icon={<DownloadOutlined/>} href={`/api/communications/attachments/${source.attachment_id}`} download>下载附件原件</Button>}
            {!complete&&<Button icon={<ReloadOutlined/>} onClick={()=>evaluate(source)} loading={pending===source.id} disabled={pending!==null}>
              {source.evaluation_status==='failed'?'重试评估':'评估这份原文'}</Button>}
          </div>
        </div>
        {source.binding_warning&&<Alert type="warning" showIcon title={source.binding_warning}/>}
        {source.error&&<Alert type="warning" showIcon title={`原文已保留，评估待重试：${source.error}`}/>}
        {evaluation&&<>
          <div className="chat-resume-evaluation-summary"><h4>评估结论</h4>
            <Typography.Paragraph>{evaluation.summary||'评估已完成'}</Typography.Paragraph>
          </div>
          {checks.length>0&&<div className="chat-resume-evaluation-section">
            <h4>{ruleRejected?'未通过的硬条件与原文依据':'岗位条件核对'} <span>{checks.length} 项</span></h4>
            <ul className="chat-resume-checks">{checks.map((item,index)=><li key={index}>
              <div className="chat-resume-check-heading"><strong>{String(item.condition||item.requirement||'核对项')}</strong>
                <Tag color={checkColors[item.status]||'default'}>{String(item.status||'待核实')}</Tag></div>
              {(item.evidence||item.reason)&&<ResumeEvidence label={item.evidence?'简历依据':'核对说明'} value={String(item.evidence||item.reason)}/>}
              {Array.isArray(item.evidence_quotes)&&item.evidence_quotes.filter(quote=>typeof quote==='string'&&quote.trim()).map((quote,quoteIndex)=><ResumeEvidence key={quoteIndex} label="简历原文依据" value={quote}/>)}
              {ruleRejected&&item.reasoning&&<p>{item.reasoning}</p>}
            </li>)}</ul>
          </div>}
          {questions.length>0&&<div className="chat-resume-questions"><h4>建议核实</h4><ul>{questions.map((question,index)=><li key={index}>
            {typeof question==='string'?question:String(question?.question||question?.text||'待核实')}
          </li>)}</ul></div>}
          <Typography.Text className="chat-resume-evaluation-note" type="secondary">{source.evaluation_saved_to_candidate?'本次评估已同步到候选人档案。':'本次评估保存在此来源记录中。'}</Typography.Text>
        </>}
        <Collapse className="chat-resume-original" size="small" items={[{key:'original',label:'查看完整原文',children:<pre className="communication-attachment-text">{source.resume}</pre>}]}/>
      </div>};
    })}/>
  </section>;
}
