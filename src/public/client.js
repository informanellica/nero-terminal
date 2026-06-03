const protocol = window.location.protocol; // http: または https:
const hostname = window.location.hostname; // ホスト名 (例: localhost)
const port = window.location.port; // ポート番号 (例: 3000)

    //const local_ip = `${protocol}//${hostname}:${port}`;
    const local_ip = `${protocol}//${hostname}:9999`;

const OPTIONS_TERM = {
    useStyle: true,
    screenKeys: true,
	fontFamily: 'Noto Sans Mono, monospace', // 日本語フォントを指定
    cursorBlink: false,
    cursorStyle: "block",
      theme: {
    background: '#000000',  // 背景色
    foreground: '#FFFFFF',  // 文字色
    cursor: '#00FF00',      // カーソル色
    black: '#000000',       // ANSI 黒
    red: '#FF0000',         // ANSI 赤
    green: '#00FF00',       // ANSI 緑
    yellow: '#FFFF00',      // ANSI 黄
    blue: '#5555FF',        // ANSI 青
    magenta: '#FF00FF',     // ANSI 紫
    cyan: '#00FFFF',        // ANSI シアン
    white: '#FFFFFF',       // ANSI 白
    brightBlack: '#808080', // ANSI 明るい黒 (灰色)
     brightRed: '#FF5555',
    brightGreen: '#55FF55',
    brightYellow: '#FFFF55',
    brightBlue: '#5555FF',
    brightMagenta: '#FF55FF',
    brightCyan: '#55FFFF',
    brightWhite: '#FFFFFF'  // ANSI 明るい白
  }
};

class Client {
    constructor(options = {}) {
        this.socket = io.connect(options.remote || local_ip);
        this.elParent = document.getElementById(options.parent || 'terminal-container') || document.body;
    }

    ab2str(buf) {
        return String.fromCharCode.apply(null, new Uint8Array(buf));
    }

    createTerminal = () => {
        let _this = this;
        this.socket.binaryType = "arraybuffer";
        this.socket.on('connect', () => {
            const term = new Terminal(OPTIONS_TERM);
            const fitAddon = new window.FitAddon.FitAddon();
            term.loadAddon(fitAddon);

            // ターミナルを表示する
            term.open(this.elParent);

            // ターミナルをウィンドウいっぱいにフィットさせる
            fitAddon.fit();

            // データの送受信を設定
            term.onData((data) => {
                _this.socket.emit('data', new TextEncoder().encode(data));
            });

            _this.socket.on('data', data => {
                if (data instanceof ArrayBuffer) {
                    term.write(_this.ab2str(data));
                }
            });

            _this.socket.on('disconnect', () => term.destroy());

            _this.socket.emit('data', '\n');

            // ウィンドウサイズが変更されたときにターミナルをリサイズ
            window.addEventListener('resize', () => {
                fitAddon.fit();
            });
        });
    }
}

export { Client };

const client = new Client({ "remote": local_ip, "parent": "terminal-container" });
client.createTerminal();

