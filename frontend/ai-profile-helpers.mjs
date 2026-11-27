export const profileKinds = [
  {value:'text',label:'文字评估'}, {value:'ocr',label:'图片文字识别（OCR）'}, {value:'asr',label:'语音识别'},
];
export const profileProviders = [
  {value:'deepseek',label:'DeepSeek'}, {value:'openai-compatible',label:'OpenAI 兼容'},
  {value:'paddleocr',label:'PaddleOCR'},
];
export const kindLabel = kind => profileKinds.find(item => item.value === kind)?.label || kind;
const clean = value => typeof value === 'string' ? value.trim() : '';
export const normalUrl = value => clean(value).replace(/\/+$/, '');
export const profileEndpoint = value => `${value?.kind}|${value?.provider}|${normalUrl(value?.base_url)}`;
const fields = ['name','kind','provider','base_url','model','docs_url'];
export function profileFormValues(profile) {
  return {...Object.fromEntries(fields.map(field => [field,profile?.[field] ||
    (field === 'kind' ? 'text' : field === 'provider' ? 'openai-compatible' : '')])),api_key:'',clear_key:false};
}
export function isProfileDirty(values, saved) {
  if (!saved) return fields.some(field => !['kind','provider'].includes(field) && clean(values?.[field])) ||
    Boolean(clean(values?.api_key));
  return fields.some(field => (field.endsWith('url') ? normalUrl(values?.[field]) : clean(values?.[field])) !==
    (field.endsWith('url') ? normalUrl(saved[field]) : clean(saved[field]))) ||
    Boolean(clean(values?.api_key)) || Boolean(values?.clear_key);
}
export function validProfileUrl(value, optional=false) {
  if (!clean(value)) return optional;
  try {
    const url = new URL(clean(value));
    return ['http:','https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password &&
      !url.search && !url.hash && !/[\s\\\x00-\x1f\x7f]/.test(clean(value));
  } catch { return false; }
}
export function safeCatalog(value) {
  if (!value || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.profiles) ||
      !value.profiles.length || typeof value.active_profile_id !== 'string') throw Error('模型列表响应无效，请重新读取配置。');
  const ids = new Set();
  const profiles = value.profiles.map(row => {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) ||
        !profileKinds.some(item => item.value === row.kind) || !profileProviders.some(item => item.value === row.provider) ||
        !['name','base_url','model'].every(field => typeof row[field] === 'string' && row[field].trim()) ||
        !validProfileUrl(row.base_url) || !validProfileUrl(row.docs_url || '',true))
      throw Error('模型列表响应无效，请重新读取配置。');
    ids.add(row.id);
    // Never retain a secret or arbitrary fields returned by a server response.
    return {id:row.id,name:row.name,kind:row.kind,provider:row.provider,base_url:row.base_url,model:row.model,
      docs_url:row.docs_url || '',has_key:Boolean(row.has_key)};
  });
  if (!profiles.some(row => row.id === value.active_profile_id && row.kind === 'text'))
    throw Error('未找到当前评估模型，请重新读取配置。');
  return {revision:value.revision,active_profile_id:value.active_profile_id,profiles};
}
export function profilePayload(values) {
  const profile = Object.fromEntries(fields.map(field => [field,field.endsWith('url') ? normalUrl(values[field]) : clean(values[field])]));
  return {...profile,clear_key:Boolean(values.clear_key),...(clean(values.api_key) ? {api_key:clean(values.api_key)} : {})};
}
