/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SiteConfigResource, StringDictionary, User } from 'azure-arm-website/lib/models';
import * as opn from "opn";
import * as portfinder from 'portfinder';
import * as vscode from 'vscode';
import { SiteClient } from 'vscode-azureappservice';
import { AzureTreeDataProvider, DialogResponses, IAzureNode, IAzureUserInput } from 'vscode-azureextensionui';
import { DebugProxy } from '../DebugProxy';
import { FunctionAppTreeItem } from '../tree/FunctionAppTreeItem';

// const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// tslint:disable-next-line:max-func-body-length
export async function remoteDebugFunctionApp(outputChannel: vscode.OutputChannel, ui: IAzureUserInput, tree: AzureTreeDataProvider, node?: IAzureNode<FunctionAppTreeItem>): Promise<void> {

    if (!node) {
        node = <IAzureNode<FunctionAppTreeItem>>await tree.showNodePicker(FunctionAppTreeItem.contextValue);
    }

    const client: SiteClient = node.treeItem.client;
    const sessionId: string = Date.now().toString();
    let debugConfig: vscode.DebugConfiguration;
    let debugRemotePort: Number;
    let debugProxy: DebugProxy;

    // tslint:disable-next-line:max-func-body-length
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, async (p: vscode.Progress<{}>) => {

        p.report({ message: 'connecting to Azure...' });

        const portNumber: number = await portfinder.getPortPromise();
        const siteConfig: SiteConfigResource = await client.getSiteConfig();

        p.report({ message: 'detecting instance type...' });

        if (siteConfig.name && siteConfig.name.toLowerCase().includes('python')) {
            // Python demo
            debugConfig = {
                name: sessionId,
                type: 'python',
                request: 'attach',
                host: 'localhost',
                port: portNumber,
                localRoot: vscode.workspace.rootPath,
                remoteRoot: '/home/site/wwwroot/HttpTrigger',
                logToFile: true,
                secret: 'my_secret'
            };
            debugRemotePort = 3000;
        } else {
            throw new Error('Azure Remote Debugging is not supported for this instance type');
        }

        p.report({ message: 'checking app settings...' });

        // Use or update App Settings
        await new Promise(async (resolve: () => void, reject: (e: any) => void): Promise<void> => {
            const isEnabled: Boolean = await isRemoteDebuggingEnabled(debugRemotePort, client);

            if (isEnabled) {
                // All good
                resolve();
            } else {
                const confirmMsg: string = 'We need to enable remote debugging for the selected app. Would you like to continue?';
                const result: vscode.MessageItem | undefined = await vscode.window.showWarningMessage(confirmMsg, DialogResponses.yes, DialogResponses.learnMore, DialogResponses.cancel);
                if (result === DialogResponses.learnMore) {
                    opn('https://aka.ms/');
                    reject('');
                } else {
                    p.report({ message: 'Updating application settings to enable remote debugging...' });
                    outputChannel.appendLine('Updating application settings to enable remote debugging...');
                    await updateAppSettings(debugRemotePort, client);

                    p.report({ message: 'Waiting for 60sec to let app reboot...' });
                    outputChannel.appendLine('Waiting for 60sec to let app reboot...');

                    // tslint:disable-next-line:no-suspicious-comment
                    // TODO: Get rid of hard-coded timeout and enable polling of app settings to make sure the setting is applied.
                    //await delay(60000);

                    resolve();
                }
            }
        });

        // Setup Debug Proxy Tunnel
        await new Promise(async (resolve: () => void, reject: (e: any) => void): Promise<void> => {
            p.report({ message: 'starting debug proxy...' });
            outputChannel.appendLine('starting debug proxy...');

            const publishCredential: User = await client.getWebAppPublishCredential();
            debugProxy = new DebugProxy(outputChannel, client, debugConfig.port, publishCredential);
            debugProxy.on('error', (err: Error) => {
                debugProxy.dispose();
                p.report({ message: 'debug proxy encourtered an error' + err });
                reject(err);
                throw err;
            });

            debugProxy.on('stop', () => {
                // DebugProxy is stopped, while debugging, try to stop debug secssion
                if (vscode.debug.activeDebugSession) {
                    vscode.commands.executeCommand('workbench.action.debug.stop')
                }
            });


            debugProxy.on('start', resolve);

            debugProxy.startProxy();
        });

        // // Start remote debugging
        p.report({ message: 'starting debugging...' });

        // Enable tracing for debug configuration
        debugConfig.trace = 'verbose';

        await vscode.debug.startDebugging(undefined, debugConfig);

        const terminateDebugListener: vscode.Disposable = vscode.debug.onDidTerminateDebugSession((event: vscode.DebugSession) => {
            if (event.name === sessionId) {
                if (debugProxy !== undefined) {
                    debugProxy.dispose();
                }
                terminateDebugListener.dispose();
            }
        });

        // TODO: Give up after 60sec if something blows up along the way.

    });
}

async function isRemoteDebuggingEnabled(debugPort: Number, client: SiteClient): Promise<Boolean> {
    const appSettings: StringDictionary = await client.listApplicationSettings();
    if (appSettings.properties && appSettings.properties.APPSVC_TUNNEL_PORT === String(debugPort)) {
        // All good
        return true;
    } else {
        return false;
    }
}

async function updateAppSettings(debugPort: Number, client: SiteClient): Promise<void> {
    const appSettings: StringDictionary = await client.listApplicationSettings();
    if (appSettings && appSettings.properties) {
        appSettings.properties.APPSVC_TUNNEL_PORT = String(debugPort);
    }
    await client.updateApplicationSettings(appSettings);
}