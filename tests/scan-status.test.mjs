import test from 'node:test';
import assert from 'node:assert/strict';
import { scanStatus } from '../src/scan-status.mjs';

test('成功後連續失敗保留舊商品數與成功時間，同時呈現新錯誤', () => {
  let status = scanStatus(undefined, { t: 1000 }, { failed: false, errors: [], count: 3 });
  assert.equal(status.lastSuccess, 1000);
  status = scanStatus(status, { t: 2000 }, { failed: true, errors: ['人機驗證'], count: 0 });
  assert.equal(status.count, 3);
  assert.equal(status.t, 2000);
  assert.equal(status.lastSuccess, 1000);
  assert.equal(status.error, '人機驗證');
  assert.equal(status.needsHuman, true);
  status = scanStatus(status, { t: 3000 }, { failed: true, errors: ['逾時'], count: 0 });
  assert.equal(status.lastSuccess, 1000);
  assert.equal(status.error, '逾時');
});

test('部分成功不更新完整成功時間，恢復後才更新並清除錯誤', () => {
  const partial = scanStatus(undefined, { t: 1000 }, { failed: false, errors: ['其中一頁格式改變'], count: 2 });
  assert.equal(partial.lastSuccess, null);
  assert.equal(partial.count, 2);
  const recovered = scanStatus(partial, { t: 2000 }, { failed: false, errors: [], count: 5 });
  assert.equal(recovered.lastSuccess, 2000);
  assert.equal(recovered.error, '');
  assert.equal(recovered.needsHuman, false);
});
