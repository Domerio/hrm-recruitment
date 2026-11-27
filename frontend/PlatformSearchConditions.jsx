import React from 'react';
import { AutoComplete, Col, Collapse, Flex, Input, Row, Select, Switch, Tag, Typography } from 'antd';
import {searchTextFields,searchToggleFields,recommendTextFields,searchSortOptions,prepareSearchConditions,searchConditionsSummary} from './platform-search-conditions.mjs';

export default function PlatformSearchConditions({value,onChange,disabled=false}) {
  const data = prepareSearchConditions(value);
  const change = (key,next) => onChange?.({...data,[key]:next});
  const locked = disabled || !data.enabled;
  return <Collapse items={[{
    key:'platform-search',
    label:<div><Flex align="center" gap={8} wrap><span>平台查询条件</span><Tag color={data.enabled?'cyan':'default'}>{data.enabled?'已启用':'未启用'}</Tag></Flex>
      <Typography.Paragraph type="secondary" ellipsis={{rows:2}} style={{fontSize:12,margin:'6px 0 0'}}>{searchConditionsSummary(data)}</Typography.Paragraph></div>,
    children:<Flex vertical gap={14}>
      <Flex align="center" gap={8}>
        <Switch id="platform-search-enabled" checked={data.enabled} disabled={disabled} onChange={next => change('enabled',next)}
          aria-label="启用平台查询条件"/>
        <Typography.Text>开始采集时自动应用到当前 BOSS 搜索或推荐页</Typography.Text>
      </Flex>
      <Typography.Text type="secondary">按岗位保存，下一次开始采集时应用。留空或选择“保留页面设置”不会修改该项；这些条件不参与 AI 评分。</Typography.Text>
      <Typography.Text strong>搜索牛人页</Typography.Text>
      <Row gutter={[12,12]}>
        {searchTextFields.map(([key,label]) => <Col xs={24} sm={12} key={key}>
          <label htmlFor={`platform-search-${key}`}>{label}</label>
          <AutoComplete id={`platform-search-${key}`} value={data[key]} onChange={next => change(key,next)} disabled={locked}
            options={key==='activity'?[{value:'3日内活跃'}]:[]} allowClear style={{width:'100%',marginTop:6}}>
            <Input maxLength={80} placeholder={key==='salary'?'如 15-25K；留空保留':'输入平台选项原文；留空保留'}/>
          </AutoComplete>
        </Col>)}
        <Col xs={24} sm={12}>
          <label htmlFor="platform-search-sort">排序方式</label>
          <Select id="platform-search-sort" value={data.sort} onChange={next => change('sort',next)} disabled={locked}
            style={{width:'100%',marginTop:6}} options={searchSortOptions.map(item => ({value:item,label:item || '保留页面设置'}))}/>
        </Col>
        {searchToggleFields.map(([key,label]) => <Col xs={24} sm={12} key={key}>
          <label htmlFor={`platform-search-${key}`}>{label}</label>
          <Select id={`platform-search-${key}`} value={data[key]===null?'keep':data[key]?'on':'off'}
            onChange={next => change(key,next==='keep'?null:next==='on')} disabled={locked} style={{width:'100%',marginTop:6}}
            options={[{value:'keep',label:'保留页面设置'},{value:'on',label:'勾选'},{value:'off',label:'取消勾选'}]}/>
        </Col>)}
      </Row>
      <Typography.Text strong>推荐牛人页</Typography.Text>
      <Typography.Text type="secondary">推荐页单独使用下方条件；活跃度、求职状态和薪资留空时继承搜索页同名条件。填“保留页面设置”可不修改该项。搜索页的其他条件不会用于推荐页。</Typography.Text>
      <Row gutter={[12,12]}>
        {recommendTextFields.map(([key,label]) => <Col xs={24} sm={12} key={key}>
          <label htmlFor={`platform-search-${key}`}>推荐页{label}</label>
          <AutoComplete id={`platform-search-${key}`} value={data[key]} onChange={next => change(key,next)} disabled={locked}
            options={[{value:'保留页面设置'}]} allowClear style={{width:'100%',marginTop:6}}>
            <Input maxLength={80} placeholder="输入推荐页显示的精确选项；留空按默认处理"/>
          </AutoComplete>
        </Col>)}
      </Row>
      <Typography.Text type="secondary">平台没有配置的精确选项时会暂停，不会按未确认的条件开始采集。</Typography.Text>
    </Flex>,
  }]}/>
}

export function PlatformSearchSummary({value}) {
  return <Typography.Paragraph type="secondary" style={{marginBottom:0}}>{searchConditionsSummary(value)}</Typography.Paragraph>;
}
