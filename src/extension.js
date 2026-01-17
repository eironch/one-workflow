const vscode = require('vscode');
const fs = require('fs-extra');
const path = require('path');
const execa = require('execa');
const { format } = require('date-fns');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new LauncherSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('one-workflow-view', provider)
  );

  // Command to kill a port
  context.subscriptions.push(
    vscode.commands.registerCommand('one-workflow.killPort', async () => {
      const port = await vscode.window.showInputBox({
        prompt: "Enter the port number to kill (e.g. 5173)",
        placeHolder: "PORT"
      });
      if (port && /^\d{4,5}$/.test(port)) {
        try {
          if (process.platform === 'win32') {
            await execa('powershell', ['-Command', `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port}).OwningProcess -Force`]);
          } else {
            await execa('bash', ['-c', `lsof -i :${port} | grep LISTEN | awk '{print $2}' | xargs kill -9`]);
          }
          vscode.window.showInformationMessage(`Port ${port} killed successfully.`);
        } catch (e) {
          vscode.window.showErrorMessage(`Failed to kill port ${port}: ${e.message}`);
        }
      }
    })
  );

  // Command for Easy ADB Pair
  context.subscriptions.push(
    vscode.commands.registerCommand('one-workflow.adbPair', async () => {
      const pairCode = await vscode.window.showInputBox({
        prompt: "Enter ADB Pair Code (e.g. 123456)",
        placeHolder: "CODE"
      });
      const pairTarget = await vscode.window.showInputBox({
        prompt: "Enter ADB Pair Target (e.g. 192.168.1.5:45678)",
        placeHolder: "IP:PORT"
      });
      if (pairCode && pairTarget) {
        try {
          const terminal = vscode.window.createTerminal({ name: 'ADB Pair', shellPath: 'cmd.exe' });
          terminal.show();
          terminal.sendText(`adb pair ${pairTarget} ${pairCode}`);
        } catch (e) {
          vscode.window.showErrorMessage(`ADB Pair failed: ${e.message}`);
        }
      }
    })
  );
}

class LauncherSidebarProvider {
  constructor(context) {
    this._context = context;
    this._view = null;
    this._interval = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._context.extensionUri] };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'launch':
          this._createTerminal(data.name, data.path, data.cmd);
          break;
        case 'openDir':
          execa('explorer', [data.path]).catch(() => {});
          break;
        case 'copyLog':
          if (data.path) {
            vscode.env.clipboard.writeText(data.path);
            vscode.window.showInformationMessage('Path copied to clipboard.');
          }
          break;
        case 'saveSettings':
          await this._context.globalState.update('settings', data.settings);
          vscode.window.showInformationMessage('One Workflow settings updated.');
          this._updateWebview();
          break;
        case 'toggleAuto':
          this._handleAutomation(data.enabled);
          break;
        case 'refresh':
          this._updateWebview();
          break;
      }
    });

    this._updateWebview();
  }

  async _updateWebview() {
    if (!this._view) return;
    const roots = this._context.globalState.get('projectRoots', [vscode.workspace.workspaceFolders?.[0]?.uri.fsPath].filter(Boolean));
    const projects = [];
    for (const root of roots) {
      if (await fs.pathExists(root)) {
        const found = await this._findPackageJsons(root);
        projects.push({ root, items: found.map(p => ({
          name: path.basename(p),
          path: p,
          pkg: require(path.join(p, 'package.json'))
        })) });
      }
    }
    const settings = this._context.globalState.get('settings', { automationKey: '{F9}', launchCommand: 'pnpm start' });
    const autoEnabled = !!this._interval;
    this._view.webview.postMessage({ type: 'projects', projects, settings, autoEnabled });
  }

  async _findPackageJsons(dir, results = []) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          if (file === 'node_modules' || file === '.git') continue;
          await this._findPackageJsons(fullPath, results);
        } else if (file === 'package.json') {
          try {
            const pkg = await fs.readJson(fullPath);
            const scripts = pkg.scripts || {};
            const runnableKeys = ['start', 'dev', 'serve', 'run', 'watch', 'android', 'ios'];
            const isRunnable = Object.keys(scripts).some(key => 
              runnableKeys.some(r => key.toLowerCase().includes(r))
            );
            if (isRunnable) {
              results.push(dir);
            }
          } catch (e) {
            console.error(`[One Workflow] Failed to parse ${fullPath}`);
          }
        }
      }
    } catch (e) {}
    return results;
  }

  _createTerminal(name, cwd, cmd) {
    const settings = this._context.globalState.get('settings', { defaultShell: 'cmd.exe' });
    const terminal = vscode.window.createTerminal({ name, cwd, shellPath: settings.defaultShell });
    terminal.show();
    terminal.sendText(cmd);
  }

  _handleAutomation(enabled) {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (enabled) {
      this._interval = setInterval(() => {
        const settings = this._context.globalState.get('settings', { automationKey: '{F9}', launchCommand: 'pnpm start', defaultShell: 'cmd.exe' });
        // Surgical focus: Ensure keys are ONLY sent to Visual Studio Code
        const command = `$wshell = New-Object -ComObject WScript.Shell; if ($wshell.AppActivate('Visual Studio Code')) { $wshell.SendKeys('${settings.automationKey}') }`;
        execa('powershell', ['-Command', command]).catch(() => {});
      }, 5000);
    }
    this._updateWebview();
  }

  _getHtml() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { padding: 10px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .section-title { font-size: 11px; font-weight: bold; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; }
        .card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .card-title { font-weight: bold; font-size: 13px; }
        .btn-group { display: flex; gap: 4px; flex-wrap: wrap; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .root-path { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #settingsOverlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--vscode-sideBar-background); z-index: 100; padding: 20px; box-sizing: border-box; }
        .settings-title { font-size: 11px; font-weight: bold; margin-bottom: 15px; text-transform: uppercase; }
        .field { margin-bottom: 15px; }
        label { display: block; font-size: 11px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
        input { width: 100%; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; box-sizing: border-box; }
        .mods { display: flex; gap: 10px; margin-top: 8px; }
        .mod { display: flex; align-items: center; gap: 4px; font-size: 11px; }
        .mod input { width: auto; }
      </style>
    </head>
    <body onload="syncUI()">
      <div id="main">
        <div class="header">
          <h2 style="font-size: 16px; margin: 0;">One Workflow</h2>
          <button onclick="vscode.postMessage({type:'refresh'})">Refresh</button>
        </div>

        <div class="section-title">
          <span>Automation</span>
          <button class="secondary" onclick="toggleSettings('Automation')">Settings</button>
        </div>
        <div class="card">
          <div class="card-header">
            <div id="autoStatus" style="font-size: 11px;">Status: <span id="statusText">Off</span></div>
            <button id="autoBtn" onclick="toggleAuto()">Start</button>
          </div>
          <div id="autoKeyDisplay" style="font-size: 10px; color: var(--vscode-descriptionForeground);">Key: <span id="currentKey">F8</span></div>
        </div>

        <div id="workspacesArea">
          <div class="section-title">
            <span>Workspaces</span>
            <button class="secondary" onclick="toggleSettings('Workspaces')">Settings</button>
          </div>
          <div id="projectsList"></div>
        </div>
      </div>

      <div id="settingsOverlay">
        <div class="settings-title">Configuration</div>
        <div class="field">
          <label>Automation Key (Press a key...)</label>
          <input type="text" id="autoKey" placeholder="e.g. F8" onkeydown="handleKeyDown(event)">
          <div class="mods">
            <div class="mod"><input type="checkbox" id="modCtrl"> Ctrl</div>
            <div class="mod"><input type="checkbox" id="modShift"> Shift</div>
            <div class="mod"><input type="checkbox" id="modAlt"> Alt</div>
          </div>
        </div>
        <div class="field">
          <label>Launch Command</label>
          <input type="text" id="launchCmd" placeholder="pnpm start">
        </div>
        <div class="field">
          <label>Default Shell</label>
          <select id="defaultShell" style="width: 100%; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;">
            <option value="cmd.exe">CMD</option>
            <option value="powershell.exe">PowerShell</option>
          </select>
        </div>
        <div class="btn-group" style="margin-top: 20px;">
          <button onclick="saveSettings()">Save</button>
          <button class="secondary" onclick="toggleSettings()">Cancel</button>
        </div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();
        let lastSaved = { automationKey: '{F9}', launchCommand: 'pnpm start', defaultShell: 'cmd.exe' };
        let mods = { ctrl: false, shift: false, alt: false };

        window.addEventListener('message', event => {
          const data = event.data;
          if (data.type === 'projects') renderProjects(data.projects);
          if (data.type === 'settings') {
            lastSaved = data.settings;
            updateStatus(data.autoEnabled);
            syncUI(data.settings);
          }
        });

        function renderProjects(roots) {
          const list = document.getElementById('projectsList');
          list.innerHTML = '';
          roots.forEach(r => {
            const rootEl = document.createElement('div');
            rootEl.className = 'root-path';
            rootEl.innerText = r.root;
            list.appendChild(rootEl);

            r.items.forEach(p => {
              const card = document.createElement('div');
              card.className = 'card';
              card.innerHTML = \`
                <div class="card-header">
                  <div class="card-title">\${p.name}</div>
                  <button class="secondary" onclick="openDir('\${p.path.replace(/\\\\/g, '\\\\\\\\')}')">Folder</button>
                </div>
                <div class="btn-group">
                  \${Object.keys(p.pkg.scripts || {}).slice(0, 5).map(s => 
                    \`<button onclick="launch('\${p.name}', '\${p.path.replace(/\\\\/g, '\\\\\\\\')}', 'pnpm \${s}')">\${s}</button>\`
                  ).join('')}
                  <button class="secondary" onclick="copyLog('\${p.path.replace(/\\\\/g, '\\\\\\\\')}')">Copy Log</button>
                </div>
              \`;
              list.appendChild(card);
            });
          });
        }

        function updateStatus(enabled) {
          document.getElementById('statusText').innerText = enabled ? 'Running' : 'Off';
          document.getElementById('autoBtn').innerText = enabled ? 'Stop' : 'Start';
        }

        function toggleAuto() {
          const enabled = document.getElementById('autoBtn').innerText === 'Start';
          vscode.postMessage({ type: 'toggleAuto', enabled });
        }

        function toggleSettings(title) {
          const overlay = document.getElementById('settingsOverlay');
          const opening = overlay.style.display !== 'block';
          if (title) document.querySelector('.settings-title').innerText = title + ' Configuration';
          if (opening) syncUI(lastSaved);
          overlay.style.display = opening ? 'block' : 'none';
        }

        function syncUI(settings) {
          if (!settings) settings = lastSaved;
          let k = settings.automationKey || '{F9}';
          
          mods.ctrl = k.includes('^');
          mods.shift = k.includes('+');
          mods.alt = k.includes('%');
          
          document.getElementById('modCtrl').checked = mods.ctrl;
          document.getElementById('modShift').checked = mods.shift;
          document.getElementById('modAlt').checked = mods.alt;
          
          let cleanKey = k.replace(/[\^\\+%{}]/g, '');
          document.getElementById('autoKey').value = cleanKey;
          document.getElementById('currentKey').innerText = k;
          document.getElementById('launchCmd').value = settings.launchCommand;
          document.getElementById('defaultShell').value = settings.defaultShell || 'cmd.exe';
        }

        function handleKeyDown(e) {
          e.preventDefault();
          const key = e.key;
          if (['Control', 'Shift', 'Alt'].includes(key)) return;
          document.getElementById('autoKey').value = key.toUpperCase();
        }

        function saveSettings() {
          const key = document.getElementById('autoKey').value;
          let fullKey = '';
          fullKey += (key || 'F9');
          if (fullKey.length > 1 || fullKey.startsWith('F')) {
             if(!fullKey.startsWith('{')) fullKey = '{' + fullKey + '}';
          }
          let modPrefix = '';
          if(document.getElementById('modCtrl').checked) modPrefix += '^';
          if(document.getElementById('modShift').checked) modPrefix += '+';
          if(document.getElementById('modAlt').checked) modPrefix += '%';
          fullKey = modPrefix + fullKey;

          lastSaved = {
            automationKey: fullKey,
            launchCommand: document.getElementById('launchCmd').value || 'pnpm start',
            defaultShell: document.getElementById('defaultShell').value || 'cmd.exe'
          };
          vscode.postMessage({ type: 'saveSettings', settings: lastSaved });
          toggleSettings();
        }

        function launch(name, path, cmd) { vscode.postMessage({ type: 'launch', name, path, cmd }); }
        function openDir(path) { vscode.postMessage({ type: 'openDir', path }); }
        function copyLog(path) { vscode.postMessage({ type: 'copyLog', path }); }
      </script>
    </body>
    </html>`;
  }
}

function deactivate() {}
module.exports = { activate, deactivate };
