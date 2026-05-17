// CLI entry — runs the signaling server standalone (no Electron).
const { startServer } = require('./lib/server');

(async () => {
  const useHttps = process.env.HTTP !== '1';
  const port = Number(process.env.PORT) || 3000;
  try {
    const { port: listenPort, lanIps } = await startServer({ port, useHttps });
    const proto = useHttps ? 'https' : 'http';
    console.log('');
    console.log('Tally');
    console.log('-----');
    console.log(`  ${proto}://localhost:${listenPort}`);
    for (const ip of lanIps) console.log(`  ${proto}://${ip}:${listenPort}`);
    console.log('');
    if (useHttps) {
      console.log('First visit on the phone will show a cert warning — tap Advanced → Proceed.');
      console.log('');
    }
  } catch (e) {
    console.error('Failed to start:', e.message);
    process.exit(1);
  }
})();
