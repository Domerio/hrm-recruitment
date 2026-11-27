// BOSS's chat route takes the numeric friend UID, not an encrypted geek ID.
// Keep string UIDs intact: converting a long UID to Number can open another chat.
export function bossChatUrl(friendId) {
  const uid = typeof friendId === 'string' ? friendId
    : Number.isSafeInteger(friendId) && friendId > 0 ? String(friendId) : '';
  if (!/^[1-9]\d{0,19}$/.test(uid)) return '';
  return `https://www.zhipin.com/web/chat/index?uid=${uid}&source=0`;
}

// A saved UID is an identity, not proof of a recruiting account's relationship.
// Keep only durable observations bound to that exact UID and a unique account.
export function candidateGreetingRecords(candidate) {
  const uid = candidate?.source?.boss_chat_uid;
  if (candidate?.deleted || typeof uid !== 'string' || !bossChatUrl(uid)) return [];
  const records = candidate?.source?.boss_greeting;
  if (!Array.isArray(records)) return [];
  const unique = new Map(), duplicates = new Set();
  for (const row of records) {
    if (!row || row.boss_chat_uid !== uid || typeof row.account_uid !== 'string' || !bossChatUrl(row.account_uid)
        || !['attempted', 'confirmed', 'already'].includes(row.state)) continue;
    if (unique.has(row.account_uid)) duplicates.add(row.account_uid);
    else unique.set(row.account_uid, row);
  }
  return [...unique.values()].filter(row => !duplicates.has(row.account_uid));
}

export const confirmedGreetingAccounts = candidate => candidateGreetingRecords(candidate)
  .filter(row => row.state === 'confirmed' || row.state === 'already');
