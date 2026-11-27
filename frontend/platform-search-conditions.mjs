export const searchTextFields = [
  ['salary','薪资区间'], ['activity','牛人活跃度'], ['job_hopping','跳槽频率'],
  ['job_status','求职状态'], ['position_requirements','牛人职位要求'], ['major','专业'],
];
export const searchToggleFields = [
  ['exclude_viewed_14d','过滤近 14 天查看'], ['exclude_contacted_30d','近 30 天未和同事交换简历'],
];
export const recommendTextFields = [
  ['recommend_activity','活跃度'], ['recommend_job_status','求职状态'], ['recommend_salary','薪资待遇'],
  ['recommend_gender','性别'], ['recommend_school','院校'],
  ['recommend_education','学历要求'], ['recommend_experience','经验要求'],
];
export const searchSortOptions = ['', '综合排序', '活跃优先', '匹配度优先'];
export function defaultSearchConditions() {
  return {enabled:false,salary:'',activity:'',job_hopping:'',job_status:'',position_requirements:'',major:'',sort:'',
    exclude_viewed_14d:null,exclude_contacted_30d:null,
    recommend_activity:'',recommend_job_status:'',recommend_salary:'',recommend_gender:'',
    recommend_school:'',recommend_education:'',recommend_experience:''};
}
export function prepareSearchConditions(value) {
  const result = defaultSearchConditions();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of Object.keys(result)) {
    if (value[key] !== undefined) result[key] = typeof value[key] === 'string' ? value[key].trim() : value[key];
  }
  return result;
}
export function validateSearchConditions(value) {
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value)))
    throw Error('平台查询条件格式无效，请重新配置。');
  const result = prepareSearchConditions(value);
  if (typeof result.enabled !== 'boolean') throw Error('请重新确认是否启用平台查询条件。');
  for (const [key,label] of [...searchTextFields,...recommendTextFields]) {
    if (typeof result[key] !== 'string' || result[key].length > 80 || /[\x00-\x1f\x7f]/.test(result[key]))
      throw Error(`${label}须为 80 字以内的平台选项原文。`);
  }
  if (!searchSortOptions.includes(result.sort)) throw Error('请选择有效的平台排序方式。');
  for (const [key,label] of searchToggleFields) {
    if (result[key] !== null && typeof result[key] !== 'boolean') throw Error(`请重新选择「${label}」状态。`);
  }
  return result;
}
export function searchConditionsSummary(value) {
  const data = prepareSearchConditions(value);
  if (!data.enabled) return '未启用，采集时保留页面设置';
  const parts = searchTextFields.filter(([key]) => data[key]).map(([key,label]) => `${label}：${data[key]}`);
  if (data.sort) parts.push(`排序：${data.sort}`);
  for (const [key,label] of searchToggleFields) if (data[key] !== null) parts.push(`${label}：${data[key] ? '勾选' : '取消勾选'}`);
  for (const [key,label] of recommendTextFields) if (data[key]) parts.push(`推荐页${label}：${data[key]}`);
  return parts.join('；') || '已启用，所有项目均保留页面设置';
}
