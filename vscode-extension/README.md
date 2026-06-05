# nero-terminal for VS Code

Open your saved SSH sessions as **native VS Code terminals** — no webview, no
embedded terminal emulator. The extension reuses the same SSH backend as the
[nero-terminal](https://github.com/informanellica/nero-terminal) desktop app and
hands the bytes to VS Code's own terminal, so you get VS Code's scrollback,
links, search, and theming for free.

## Features

- **Saved sessions** in the *nero-terminal* activity-bar view — add, edit, remove.
- Open a session as a terminal from the view, the command palette
  (`nero-terminal: Connect to saved session…`), or the terminal **+** dropdown
  (`nero-terminal: SSH session`).
- **Authentication**: password, private-key file (with optional passphrase), or
  be prompted in the terminal (PuTTY-style `login as:` / `password:`).
- **X11 forwarding** per session (forwards to a local X server such as VcXsrv on
  `127.0.0.1:6000`).
- Passwords and key passphrases are kept in VS Code **Secret Storage**, never in
  settings or synced state.

## Usage

1. Open the *nero-terminal* view in the activity bar.
2. **Add SSH session** and fill in host / port / user / auth.
3. Click a session (or the plug icon) to open it as a terminal.

## Build from source

```bash
npm install
npm run build      # bundles into dist/extension.js
npm run package    # produces a .vsix (requires @vscode/vsce)
```

## License

MIT © Informanellica
