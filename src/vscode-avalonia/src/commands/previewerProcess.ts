import * as vscode from "vscode";
import { Command } from "../commandManager";
import { AppConstants, logger } from "../util/Utilities";
import { PreviewerParams } from "../models/PreviewerParams";
import { spawn } from "child_process";

import * as portfinder from "portfinder";
import * as fs from "fs";
import { PreviewerData } from "../models/previewerSettings";
import { PreviewProcessManager } from "../previewProcessManager";
import { PreviewServer } from "../services/previewServer";

export class PreviewerProcess implements Command {
	id: string = AppConstants.previewProcessCommandId;

	async execute(mainUri?: vscode.Uri): Promise<PreviewerData> {
		logger.appendLine(`Command ${this.id}, ${mainUri}`);
		let result: PreviewerData = { file: mainUri! };
		const previewParams = this._context.workspaceState.get<PreviewerParams>(AppConstants.previewerParamState);
		if (previewParams && mainUri) {
			result = await this.startPreviewerProcess(previewParams, mainUri);
		}

		return result;
	}

	async startPreviewerProcess(previewParams: PreviewerParams, mainUri: vscode.Uri): Promise<PreviewerData> {
		if (!this.canStartPreviewerProcess(previewParams)) {
			logger.appendLine(`Previewer path not found: ${previewParams.previewerPath}`);
			return { file: mainUri, previewerUrl: "", assetsAvailable: false };
		}

		const previewerData = this._processManager.getPreviewerData(mainUri.toString());
		if (previewerData) {
			logger.appendLine(`Previewer process already started: ${previewerData.pid}`);
			return previewerData;
		}

		const httpPort = await portfinder.getPortPromise();
		const bsonPort = httpPort + 1; //await portfinder.getPortPromise({ startPort: 9000 });
		const htmlUrl = `${AppConstants.htmlUrl}:${httpPort}`;
		const xamlFile = mainUri.fsPath;

		const server = PreviewServer.getInstance(xamlFile, bsonPort);
		if (!server.isRunnig) {
			await server.start();
			console.log(`Preview server started on port ${bsonPort}`);
		}

		const previewerArags = [
			"exec",
			`--runtimeconfig ${previewParams.projectRuntimeConfigFilePath}`,
			`--depsfile ${previewParams.projectDepsFilePath} ${previewParams.previewerPath}`,
			"--method avalonia-remote",
			`--transport tcp-bson://${AppConstants.localhost}:${bsonPort}/`,
			"--method html",
			`--html-url ${htmlUrl}`,
			previewParams.targetPath,
		];

		return new Promise((resolve, reject) => {
			const previewer = spawn("dotnet", previewerArags, {
				env: process.env,
				shell: true,
			});

			previewer.on("spawn", () => {
				logger.appendLine(`Previewer process started with args: ${previewerArags}`);
				let wsAddress = AppConstants.webSocketAddress(httpPort);
				let previewerData = {
					file: mainUri,
					previewerUrl: htmlUrl,
					assetsAvailable: true,
					pid: previewer.pid,
					wsAddress: wsAddress,
				};
				this._processManager.addProcess(xamlFile, previewerData);
				resolve(previewerData);
			});

			previewer.stdout.on("data", (data) => {
				logger.appendLine(data.toString());
			});

			previewer.stderr.on("data", (data) => {
				logger.appendLine(data.toString());
				reject(data.toString());
			});

			previewer.on("close", (code) => {
				logger.appendLine(`Previewer process exited with code ${code}`);
			});
		});
	}

	canStartPreviewerProcess(previewParams: PreviewerParams) {
		const result =
			fs.existsSync(previewParams.previewerPath) &&
			fs.existsSync(previewParams.projectRuntimeConfigFilePath) &&
			fs.existsSync(previewParams.projectDepsFilePath) &&
			fs.existsSync(previewParams.targetPath);

		return result;
	}
	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _processManager: PreviewProcessManager
	) {}
}
