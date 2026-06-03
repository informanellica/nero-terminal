
var term = new Terminal({
    cursorBlink: "block",
    cursorBlink: false,
});

term.open(document.getElementById('terminal'));

function prompt(term) {
    command = '';
    term.write('\r\n$ ');
}

var command = '';

term.prompt = () => {
    term.write('\r\n$ ');
};

prompt(term);

term.onData(e => {
    switch (e) {
        case '\u0003': // Ctrl+C
            term.write('^C');
            prompt(term);
            break;
        case '\r': // Enter
            runCommand(term, command);
            command = '';
            break;
        case '\u007F': // Backspace (DEL)
            // Do not delete the prompt
            if (term._core.buffer.x > 2) {
                term.write('\b \b');
                if (command.length > 0) {
                    command = command.substr(0, command.length - 1);
                }
            }
            break;
        default: // Print all other characters for demo
            if (e >= String.fromCharCode(0x20) && e <= String.fromCharCode(0x7E) || e >= '\u00a0') {
                command += e;
                term.write(e);
            }
    }
});

var commands = {
    help: {
        f: () => {
            term.writeln([
                'Welcome to xterm.js! Try some of the commands below.',
                '',
                ...Object.keys(commands).map(e => `  ${e.padEnd(10)} ${commands[e].description}`)
            ].join('\n\r'));
            prompt(term);
        },
        description: 'Prints this help message',
    },
    ls: {
        f: () => {
            term.writeln(['a', 'bunch', 'of', 'fake', 'files'].join('\r\n'));
            term.prompt(term);
        },
        description: 'Prints a fake directory structure'
    },
    loadtest: {
        f: () => {
            let testData = [];
            let byteCount = 0;
            for (let i = 0; i < 50; i++) {
                let count = 1 + Math.floor(Math.random() * 79);
                byteCount += count + 2;
                let data = new Uint8Array(count + 2);
                data[0] = 0x0A; // \n
                for (let i = 1; i < count + 1; i++) {
                    data[i] = 0x61 + Math.floor(Math.random() * (0x7A - 0x61));
                }
                // End each line with \r so the cursor remains constant, this is what ls/tree do and improves
                // performance significantly due to the cursor DOM element not needing to change
                data[data.length - 1] = 0x0D; // \r
                testData.push(data);
            }
            let start = performance.now();
            for (let i = 0; i < 1024; i++) {
                for (const d of testData) {
                    term.write(d);
                }
            }
            // Wait for all data to be parsed before evaluating time
            term.write('', () => {
                let time = Math.round(performance.now() - start);
                let mbs = ((byteCount / 1024) * (1 / (time / 1000))).toFixed(2);
                term.write(`\n\r\nWrote ${byteCount}kB in ${time}ms (${mbs}MB/s) using the ${isWebglEnabled ? 'webgl' : 'canvas'} renderer`);
                term.prompt();
            });
        },
        description: 'Simulate a lot of data coming from a process'
    }
};

function runCommand(term, text) {
    const command = text.trim().split(' ')[0];
    if (command.length > 0) {
        term.writeln('');
        if (command in commands) {
            commands[command].f();
            return;
        }
        term.writeln(` ${command}: command not found`);
    }
    prompt(term);
}

// コンソールへの入力を有効にする
term.focus();

const terminalContainer = document.getElementById('popupWindow');
const windowHeaderElem = document.getElementById('windowHeader');

const fitAddon = new FitAddon.FitAddon();

function fitTerminal() {
    term.loadAddon(fitAddon);
    fitAddon.fit();
    console.log(fitAddon);

    //const term_element = document.querySelector('.xterm-viewport');
    const term_element = document.getElementById('terminal');
    const availableHeight = terminalContainer.offsetHeight - windowHeaderElem.offsetHeight; // または clientHeight や getBoundingClientRect() を使用
    const terminalHeight = term_element.offsetHeight; // または clientHeight や getBoundingClientRect() を使用
    console.log('要素の高さ:', availableHeight);
    console.log('terminalの高さ:', terminalHeight);

    function resizeTerminal() {
        const {height} = terminalContainer.getBoundingClientRect();
        //const rows = Math.floor(height / term._core._renderService.dimensions.actualCellHeight);
        //console.log(term.cols, term.rows, height , term._core._renderService.dimensions.actualCellHeight);
        //term.resize(parseInt(term.cols), parseInt(rows));
        const estimatedRowHeight = terminalHeight / term.rows;
        const estimatedHeight = parseInt(availableHeight / estimatedRowHeight);

        console.log(availableHeight, estimatedRowHeight, term.rows, estimatedHeight);

        term.resize(term.cols, estimatedHeight - 1);
    }
    resizeTerminal()
}

terminalContainer.addEventListener('resize', fitTerminal);

// 初期化時に一度フィットさせる
fitTerminal();
