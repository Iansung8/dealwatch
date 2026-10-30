#!/usr/bin/env node
// doctor 在載入設定、憑證與監控狀態前分流；診斷本身不啟動服務。
if (process.argv[2] === 'doctor') {
  const { doctorCli } = await import('./src/doctor.mjs');
  process.exitCode = await doctorCli(process.argv.slice(3));
} else {
  await import('./src/monitor.mjs');
}
