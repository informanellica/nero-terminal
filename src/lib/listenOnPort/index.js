
const fs = require('fs');

const remoteServerUrl = 'http://localhost:3000/api/port'; // 送信先のサーバーURL
const startPort = 3000;
const package_json = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
const appname = package_json.name

function run(arg_app, arg_port){

    // ポートを使用してサーバーを起動する関数
    function listen(port, app) {
        return new Promise((resolve, reject) => {
            const server = app.listen(port, () => {
                console.log(`${appname} is listening on port ${port}`);
                resolve(port);
            });

            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.log(`worldclock Port ${port} is already in use. Trying port ${port + 1}...`);
                    resolve(listen(port + 1, app)); // 次のポートで再試行
                } else {
                    reject(err);
                }
            });
        });
    }

    listen(arg_port, arg_app)
        .then((availablePort) => {
            // ポート情報を別のサーバーに送信
            return fetch(remoteServerUrl, {
                method : 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({id: appname, port: availablePort})
            });
        })
        .then((response) => {
            if (!response.ok) {
                throw new Error(`Failed to send port information: ${response.statusText}`);
            }
            console.log('Port information sent successfully');
        })
        .catch((error) => {
            console.error('Error starting server or sending port information:', error);
        });

}

module.exports = {run};
