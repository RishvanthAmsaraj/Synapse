// One-shot WS client to verify the Synapse backend ↔ Gemini Live loop.
// Connects, waits for 'ready', sends a text turn, and reports what comes back.
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3001/api/live');
const seen = { ready: 0, audio: 0, tool_call: [], turn_complete: 0, interrupted: 0, other: 0 };
let sent = false;
const t0 = Date.now();

ws.on('open', () => console.log('[client] ws open'));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'ready') {
    seen.ready++;
    console.log('[client] READY — Gemini session open');
    if (!sent) {
      sent = true;
      ws.send(JSON.stringify({ type: 'context', text: 'Explain recursion in two sentences.' }));
      console.log('[client] sent context text');
    }
  } else if (msg.type === 'audio') {
    seen.audio++;
    if (seen.audio === 1) console.log('[client] first audio chunk arrived');
  } else if (msg.type === 'tool_call') {
    seen.tool_call.push(msg.name);
    console.log('[client] tool_call:', msg.name, JSON.stringify(msg.args).slice(0, 120));
  } else if (msg.type === 'turn_complete') {
    seen.turn_complete++;
    console.log('[client] turn_complete');
    finish();
  } else if (msg.type === 'interrupted') {
    seen.interrupted++;
  } else {
    seen.other++;
  }
});

function finish() {
  console.log('SUMMARY', JSON.stringify(seen), 'elapsed_s', ((Date.now() - t0) / 1000).toFixed(1));
  ws.close();
  process.exit(0);
}

ws.on('error', (e) => { console.error('[client] ws error:', e.message); process.exit(1); });
ws.on('close', () => console.log('[client] ws closed'));
setTimeout(() => { console.log('TIMEOUT SUMMARY', JSON.stringify(seen)); process.exit(seen.ready ? 0 : 2); }, 40000);
