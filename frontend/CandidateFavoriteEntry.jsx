import { Button } from 'antd';
import { favoriteFinderUrl } from './favorite-finder-link.mjs';

export default function CandidateFavoriteEntry({ candidate, extensionId, size }) {
  if (!candidate || candidate.deleted) return null;
  const href = favoriteFinderUrl(candidate, extensionId, globalThis.location?.origin);
  const reason = !extensionId ? '请先在连接与集成中授权本浏览器安装的 BOSS 扩展。'
    : '请通过工作台的本机或局域网 IP 地址打开，并使用已授权扩展的浏览器。';
  return <span title={href ? '自动查找 BOSS 收藏中的对应卡片，核验后滚动到卡片并高亮显示。' : reason}>
    <Button size={size} disabled={!href} href={href || undefined} target="_blank" rel="noopener noreferrer">
      收藏中定位
    </Button>
  </span>;
}
