'use strict';

const vscode = require('vscode');
const { SessionStore } = require('./sessions');
const { SessionTreeProvider } = require('./tree');
const { NeroPseudoterminal } = require('./nero-pty');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const store = new SessionStore(context);
  const tree = new SessionTreeProvider(store);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('neroTerminal.sessions', tree),

    vscode.commands.registerCommand('neroTerminal.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('neroTerminal.addSession', () => editSession(store)),
    vscode.commands.registerCommand('neroTerminal.editSession', (s) => editSession(store, s)),
    vscode.commands.registerCommand('neroTerminal.removeSession', (s) => removeSession(store, s)),
    vscode.commands.registerCommand('neroTerminal.connect', (s) => connect(store, s)),
    vscode.commands.registerCommand('neroTerminal.quickConnect', () => quickConnect(store)),

    // Lets a session be launched from the terminal "+" split-button dropdown.
    vscode.window.registerTerminalProfileProvider('nero-terminal.sshProfile', {
      async provideTerminalProfile() {
        const session = await pickSession(store);
        if (!session) return undefined;
        const pty = await makePty(store, session);
        if (!pty) return undefined;
        return new vscode.TerminalProfile({ name: terminalName(session), pty });
      },
    }),
  );
}

function deactivate() {}

/** Prompt-driven create/edit of a session. @param {object=} existing */
async function editSession(store, existing) {
  const cur = existing || {};
  const name = await vscode.window.showInputBox({
    title: 'Session name', value: cur.name || '', prompt: 'A label for this session',
    validateInput: (v) => (v && v.trim() ? undefined : 'Required'),
  });
  if (name === undefined) return;

  const host = await vscode.window.showInputBox({
    title: 'Host', value: cur.host || '', prompt: 'Hostname or IP',
    validateInput: (v) => (v && v.trim() ? undefined : 'Required'),
  });
  if (host === undefined) return;

  const portStr = await vscode.window.showInputBox({
    title: 'Port', value: String(cur.port || 22),
    validateInput: (v) => (/^\d+$/.test(v) ? undefined : 'Must be a number'),
  });
  if (portStr === undefined) return;

  const username = await vscode.window.showInputBox({
    title: 'Username', value: cur.username || '', prompt: 'Leave empty to be prompted in the terminal',
  });
  if (username === undefined) return;

  const authPick = await vscode.window.showQuickPick(
    [
      { label: 'Password', value: 'password' },
      { label: 'Private key file', value: 'key' },
      { label: 'Prompt in terminal', value: 'prompt' },
    ],
    { title: 'Authentication' },
  );
  if (!authPick) return;
  const authType = authPick.value;

  let keyPath = cur.keyPath;
  let password, passphrase;
  if (authType === 'key') {
    const picked = await vscode.window.showOpenDialog({
      title: 'Select private key file', canSelectMany: false, openLabel: 'Use key',
    });
    if (!picked || !picked.length) return;
    keyPath = picked[0].fsPath;
    passphrase = await vscode.window.showInputBox({
      title: 'Key passphrase', password: true, prompt: 'Leave empty if the key is not encrypted',
    });
    if (passphrase === undefined) return;
  } else if (authType === 'password') {
    password = await vscode.window.showInputBox({
      title: 'Password', password: true, prompt: 'Stored in VS Code Secret Storage',
    });
    if (password === undefined) return;
  }

  const x11 = (await vscode.window.showQuickPick(['No', 'Yes'], { title: 'Enable X11 forwarding?' })) === 'Yes';

  const session = {
    id: cur.id || `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: name.trim(), host: host.trim(), port: Number(portStr), username: username.trim(),
    authType, keyPath: authType === 'key' ? keyPath : undefined, x11,
  };
  if (password !== undefined) session.password = password;
  if (passphrase !== undefined) session.passphrase = passphrase;
  await store.save(session);
  vscode.window.showInformationMessage(`Saved session "${session.name}".`);
}

async function removeSession(store, s) {
  const session = s || (await pickSession(store));
  if (!session) return;
  const yes = await vscode.window.showWarningMessage(
    `Remove session "${session.name}"?`, { modal: true }, 'Remove',
  );
  if (yes === 'Remove') await store.remove(session.id);
}

async function connect(store, s) {
  const session = s || (await pickSession(store));
  if (!session) return;
  const pty = await makePty(store, session);
  if (!pty) return;
  const terminal = vscode.window.createTerminal({ name: terminalName(session), pty });
  terminal.show();
}

async function quickConnect(store) {
  return connect(store);
}

/**
 * Resolve secrets (prompting for a password if one is required but not stored)
 * and build a {@link NeroPseudoterminal} for the session.
 */
async function makePty(store, session) {
  const secrets = await store.secrets(session.id);
  if (session.authType === 'password' && !secrets.password) {
    const pw = await vscode.window.showInputBox({
      title: `Password for ${session.username || ''}@${session.host}`, password: true,
    });
    if (pw === undefined) return undefined;
    secrets.password = pw;
  }
  return new NeroPseudoterminal(session, secrets);
}

async function pickSession(store) {
  const list = store.list();
  if (!list.length) {
    const add = await vscode.window.showInformationMessage('No saved sessions.', 'Add SSH session');
    if (add) await vscode.commands.executeCommand('neroTerminal.addSession');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    list.map((s) => ({
      label: s.name || s.host,
      description: `${s.username ? s.username + '@' : ''}${s.host}:${s.port || 22}`,
      session: s,
    })),
    { title: 'Connect to saved session', matchOnDescription: true },
  );
  return pick && pick.session;
}

function terminalName(session) {
  return session.name || `${session.username ? session.username + '@' : ''}${session.host}`;
}

module.exports = { activate, deactivate };
