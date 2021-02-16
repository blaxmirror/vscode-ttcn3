import fs = require('fs');
import path = require('path');
import * as child_process from "child_process";
import * as vscode from 'vscode';
import { commands, ExtensionContext, OutputChannel} from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient';
import { LOG } from './util/logger';
import { ServerDownloader } from './serverDownloader';
import { Status, StatusBarEntry } from './util/status';
import { isOSUnixoid, correctBinname } from './util/osUtils';

let client: LanguageClient;

export function activate(context: ExtensionContext) {

	const conf = vscode.workspace.getConfiguration('ttcn3');

	// Our work is done, if the user does not want to run a language server.
	if (!conf.get('useLanguageServer')) {
		LOG.info('Language server is disabled. If you like to use features like go to definition, enable the language server by opening vscode settings and set ttcn3.useLanguageServer to true. For more information about the TTCN-3 language server, have a look at https://nokia.github.io/ntt/editors/');
		return;
	}

	const initTasks: Promise<void>[] = [];

	initTasks.push(withSpinningStatus(context, async status => {
		await activateLanguageServer(context, status, conf);
	}));
}

async function withSpinningStatus(context: vscode.ExtensionContext, action: (status: Status) => Promise<void>): Promise<void> {
	const status = new StatusBarEntry(context, "$(sync~spin)");
	status.show();
	await action(status);
	status.dispose();
}

export async function activateLanguageServer(context: vscode.ExtensionContext, status: Status, conf: vscode.WorkspaceConfiguration) {

	const outputChannel = vscode.window.createOutputChannel("TTCN-3");
	context.subscriptions.push(outputChannel);

	LOG.info('Activating language server for TTCN-3...');
	status.update('Activating language server for TTCN-3...');

	const installDir = path.join(context.extensionPath, "servers");
	const nttDownloader = new ServerDownloader("TTCN-3 Language Server", "ntt", assetName(), installDir);

	try {
		await nttDownloader.downloadServerIfNeeded(status);
		// Ensure that start script can be executed
		if (isOSUnixoid()) {
			child_process.exec(`chmod +x ${installDir}/ntt`);
		}
	} catch (error) {
		console.error(error);
		vscode.window.showWarningMessage(`Could not update/download TTCN-3 Language Server: ${error}`);
		return;
	}

	const ntt = await findNttExecutable(installDir);
	if (ntt == null) {
		vscode.window.showErrorMessage("Couldn't locate ntt in $PATH");
		return;
	}

	status.update(`Initializing TTCN-3 Language Server...`);

	let serverOptions: ServerOptions = {
		run:   { command: ntt, args: ['langserver'] },
		debug: { command: ntt, args: ['langserver'] }
	};

	let clientOptions: LanguageClientOptions = {
		documentSelector: ['ttcn3'],
		outputChannel: outputChannel
	};

	// Create the language client and start the client.
	client = new LanguageClient( 'ttcn3', 'TTCN-3 Language Server', serverOptions, clientOptions);
	try {
		context.subscriptions.push(client.start());
	} catch (e) {
		vscode.window.showInformationMessage('Could ot start the TTCN-3 language server:', e);
	}

	context.subscriptions.push(vscode.commands.registerCommand("ttcn3.languageServer.restart", async () => {
		await client.stop();

		outputChannel.appendLine("");
		outputChannel.appendLine(" === Language Server Restart ===")
		outputChannel.appendLine("");

		context.subscriptions.push(client.start());
	}));
}

async function findNttExecutable(installDir: string): Promise<string> {
	let ntt = correctBinname("ntt");
	let nttPath = path.join(installDir, ntt);

	// Try installed binary
	if (fs.existsSync(nttPath)) {
		return nttPath;
	}

	// Then search PATH parts
	if (process.env['PATH']) {
		LOG.info("Looking for ntt in PATH");

		let pathparts = process.env['PATH'].split(path.delimiter);
		for (let i = 0; i < pathparts.length; i++) {
			let binpath = path.join(pathparts[i], ntt);
			if (fs.existsSync(binpath)) {
				return binpath;
			}
		}
	}

	LOG.info("Could not find ntt, will try using binary name directly");
	return ntt;
}

function assetName(): string {
	const os = getOs();
	const arch = getArch();
	return `ntt_${os}_${arch}.tar.gz`;
}

function getOs(): string {
	let platform = process.platform.toString();
	if (platform === 'win32') {
		return 'windows';
	}
	return platform;
}

function getArch(): string {
	let arch = process.arch;

	if (arch === 'ia32') {
		return 'i386';
	}
	if (arch === 'x64') {
		return 'x86_64';
	}
	if (arch === 'arm64' && process.platform.toString() === 'darwin') {
		// On Apple Silicon, install the amd64 version and rely on Rosetta2
		// until a native build is available.
		return 'x86_64';
	}
	return arch;
}
export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}