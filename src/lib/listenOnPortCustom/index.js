
const fs = require('fs');

const remoteServerUrl = 'http://localhost:3000/api/port'; // 送信先のサーバーURL
const package_json = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
const appname = package_json.name

let resolvedPort = null;

function run(arg_app, arg_port) {
    return new Promise(rslv=>{
    // ポートを使用してサーバーを起動する関数
    function listen(port, app) {
        return new Promise((resolve, reject) => {
            const server = app.listen(port, () => {
                console.log(`${appname} is listening on port ${port}`);
                resolve(port); // 使用可能なポートをresolveで返す
            });

            server.on('error', (err) => {
                //if (err.code === 'EADDRINUSE') {
                if (err.code === 'ERR_SERVER_ALREADY_LISTEN' || err.code === 'EADDRINUSE') {
                    server.close(() => {
                    console.log(`${appname} ${port} is already in use. Trying port ${port + 1}...`);
                    // 次のポートで再試行
                    resolve(listen(port + 1, app));
                    })
                } else {
                    reject(err); // 他のエラーが発生した場合
                }
            });
        });
    }

    // listen関数の結果をPromiseで待機し、ポートが決まったら返す
        listen(arg_port, arg_app)
            .then((availablePort) => {

                resolvedPort = availablePort;

                // ポート情報を別のサーバーに送信
                return fetch(remoteServerUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ id: appname, port: resolvedPort })
                })
            })
            .then((response) => {
                if (!response.ok) {
                    console.log(`Failed to send port information: ${response.statusText}`);
                }
                    console.log('Port information sent successfully');
                    rslv(resolvedPort); // 成功したポートを返す
            })
            .catch((error) => {
                console.error('Error starting server or sending port information:', error);
                throw error; // エラーを再スロー
            });
        });
}

module.exports = {run};
