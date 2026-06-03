const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
let serverProcess = null; // `server.js`のプロセス
let isRunning = false; // サーバーの状態管理

const listenOnPort = require('./lib/listenOnPort');

// アプリケーションのポートを指定
const port = 3000;

// JSONでリクエスト・レスポンスをやり取りするために必要なミドルウェア
app.use(express.json());
// 静的ファイルを提供
app.use(express.static(path.join(__dirname, 'public')));

// サーバーを起動する関数
function startServer() {
  if (serverProcess && isRunning) {
    return { status: 'Server is already running' };
  }

  // server.jsをspawnで起動
  serverProcess = spawn('node', [path.join(__dirname, 'server.js')]);

  serverProcess.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });

  serverProcess.on('close', (code) => {
    isRunning = false;
    console.log(`Server process exited with code ${code}`);
  });

  isRunning = true;
  return { status: 'Server started' };
}

// サーバーを停止する関数
function stopServer() {
  if (!serverProcess || !isRunning) {
    return { status: 'Server is not running' };
  }

  // プロセスを停止
  serverProcess.kill();
  isRunning = false;
  return { status: 'Server stopped' };
}

// POST: サーバーを起動
app.post('/api/server', (req, res) => {
  const result = startServer();
  res.json(result);
});

// DELETE: サーバーを停止
app.delete('/api/server', (req, res) => {
  const result = stopServer();
  res.json(result);
});

// PUT: サーバーをリスタート
app.put('/api/server', (req, res) => {
  stopServer();
  const result = startServer();
  res.json(result);
});

// // GET: サーバーの状態を確認
// app.get('/api/server', (req, res) => {
//   const status = isRunning ? 'running' : 'stopped';
//   const port = 3000; // サーバーが動作するポート
//   res.json({ status, port });
// });

// サーバーを起動
listenOnPort.run(app, port)

startServer()

// プロセスが終了する前に、サーバープロセスをクリーンアップ
process.on('exit', () => {
  if (serverProcess && isRunning) {
    serverProcess.kill();
  }
});

process.on('SIGINT', () => {
  console.log('Caught interrupt signal');
  process.exit();
});

