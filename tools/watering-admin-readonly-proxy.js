'use strict';

// Local-only browser verification against hubert's running dashboard. Never forwards writes.
const http = require('node:http');
const { spawn } = require('node:child_process');

const port = Number(process.env.WATERING_VERIFY_PORT || 18792);
http.createServer(async (request, response) => {
  if (request.method !== 'GET' && !(request.method === 'POST' && request.url === '/api/watering-circuits/preview')) {
    response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Read-only UI-verifikation: ændringer videresendes ikke.' }));
    return;
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16384) {
      response.writeHead(413).end(); return;
    }
  }
  const input = Buffer.from(JSON.stringify({ path: request.url, method: request.method, body })).toString('base64');
  const remote = `
import subprocess,json,base64
code=r'''
const fs=require('fs'),crypto=require('crypto');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const secret=process.env.DASHBOARD_COOKIE_SECRET || (process.env.DASHBOARD_PASSWORD+':'+(process.env.HOMEY_APP_ID||'com.rothmann.soil'));
const signature=crypto.createHmac('sha256',secret).update('authenticated').digest('base64url');
fetch('http://127.0.0.1:8787'+input.path,{method:input.method,headers:{cookie:'soil_dashboard_session=authenticated.'+signature,'content-type':'application/json'},...(input.method==='POST'?{body:input.body}:{})})
.then(async r=>console.log(JSON.stringify({status:r.status,type:r.headers.get('content-type'),body:Buffer.from(await r.arrayBuffer()).toString('base64')})))
.catch(()=>{console.error('Dashboard verification request failed');process.exitCode=1;});
'''
subprocess.run(['docker','exec','-i','soil-dashboard','node','-e',code],input=base64.b64decode('${input}'),check=True)
`;
  const child = spawn('ssh', ['-o', 'ConnectTimeout=10', 'fro@192.168.100.67', 'python3', '-'], { windowsHide: true });
  const output = [];
  child.stdout.on('data', (data) => output.push(data));
  child.stderr.resume();
  const timeout = setTimeout(() => child.kill(), 30000);
  child.on('error', () => {
    clearTimeout(timeout); response.writeHead(502).end();
  });
  child.on('close', (code) => {
    clearTimeout(timeout);
    if (response.writableEnded) return;
    try {
      if (code !== 0) throw new Error('SSH failed');
      const result = JSON.parse(Buffer.concat(output).toString('utf8'));
      response.writeHead(result.status, { 'content-type': result.type || 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(Buffer.from(result.body, 'base64'));
    } catch {
      response.writeHead(502).end('Runtime verification proxy failed');
    }
  });
  child.stdin.end(remote);
}).listen(port, '127.0.0.1', () => console.log(`Read-only hubert UI verification at http://127.0.0.1:${port}/#circuits`));
