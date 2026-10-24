import type { UserAction } from '../core/types.js';
import { type SpawnFn } from './aerender.js';
export declare const BRIDGE_ID = "com.catcut.bridge";
export interface PremiereProjectRef {
    name: string;
    path: string;
}
export interface PremiereSequenceRef {
    name: string;
    id: string;
    active?: boolean;
}
export interface PremiereBridgeStatus {
    /** extension folder present under the per-user CEP extensions folder (cepExtensionsDir) */
    installed: boolean;
    installDir: string;
    /** a bridge heartbeat younger than staleMs */
    connected: boolean;
    queueDir: string;
    premiere?: string;
    /** bridge version Premiere is running (from the heartbeat) */
    bridge?: string;
    project?: PremiereProjectRef | null;
    heartbeatAgeMs?: number;
    /** the request Premiere is working on right now */
    busy?: {
        action: string;
        seconds: number;
    } | null;
}
export interface PremiereClient {
    status(): Promise<PremiereBridgeStatus>;
    /** Run one bridge action; rejects with Premiere's error text (or a UserActionError). */
    call<T>(action: string, args?: Record<string, unknown>, opts?: {
        timeoutMs?: number;
    }): Promise<T>;
    /** Folder both sides can read and write (ASCII). */
    readonly queueDir: string;
    readonly installDir: string;
}
/** Where bridges before 0.3 kept the queue (cleanup tools empty TEMP, which dropped the bridge). */
export declare function legacyQueueDir(): string;
/**
 * %LOCALAPPDATA%\CatCut\bridge (~/Library/Application Support/CatCut/bridge on macOS; same rule as the
 * bridge's index.html); TEMP only when that path is not ASCII.
 */
export declare function defaultQueueDir(): string;
/** Per-user CEP extensions folder: %APPDATA%\Adobe\CEP\extensions or ~/Library/Application Support/Adobe/CEP/extensions. */
export declare function cepExtensionsDir(): string;
export declare function createPremiereClient(opts?: {
    queueDir?: string;
    staleMs?: number;
    pollMs?: number;
    installDir?: string;
    /** reads Premiere's windows so a long busy spell is told apart from a dialog (no host: always the dialog card) */
    host?: Pick<PremiereHost, 'running' | 'windows'>;
}): PremiereClient;
/** A unique ASCII file in the queue folder for Premiere to read or write. */
export declare function stagePath(client: PremiereClient, ext: string): Promise<string>;
export interface PremiereHost {
    /** Premiere processes running ("Adobe Premiere Pro.exe" / the macOS app) */
    running(): Promise<number[]>;
    /** CSXS runtimes whose PlayerDebugMode is not 1 (CatCut's unsigned bridge would not load there) */
    debugModeMissing(): Promise<string[]>;
    /** Start Premiere with a project; must not wait for it to exit. */
    launch(exe: string, project: string): {
        pid?: number;
    };
    /** Premiere's top-level windows (Windows only; undefined when they cannot be read). */
    windows?(pids: number[]): Promise<PremiereWindows | undefined>;
    /** Bring Premiere's main window to the front once: CEP starts the bridge on ApplicationActivate. */
    activate?(pids: number[]): Promise<'active' | 'tried' | 'no-window' | undefined>;
}
export interface PremiereWindows {
    /** a main window is disabled: a modal dialog waits for the person */
    modal: boolean;
    /** titles of Premiere's dialogs while modal */
    dialogs: string[];
    /** Windows shows Premiere as "Not Responding" (also while it renders: not a reason to click) */
    hung: boolean;
}
/** PowerShell command for one CatCutWin call; pids are integers, so nothing user-supplied reaches the script. */
export declare function winHelperScript(method: 'Probe' | 'Activate', pids: number[]): string;
/** Parse CatCutWin.Probe output; undefined when the probe did not finish. */
export declare function parseWindowProbe(stdout: string): PremiereWindows | undefined;
export declare function premiereHost(spawn?: SpawnFn): PremiereHost;
export interface PremiereDiagnosis {
    /** connected and nothing in the way (an older bridge still counts: it works with fewer actions) */
    ready: boolean;
    status: PremiereBridgeStatus;
    running: boolean;
    versions: {
        catcut?: string;
        installed?: string;
        loaded?: string;
    };
    /** what the person must do, when anything (with ready: true it is advice, not a blocker) */
    userAction?: UserAction;
    /** an older bridge: the newer premiere_* tools answer with the update card */
    limited?: boolean;
    /** connected and working on a long request with no dialog open: calls wait for it */
    busy?: boolean;
    /** one line for the agent */
    note: string;
}
export declare function diagnosePremiere(client: PremiereClient, host: PremiereHost, opts?: {
    premiereExe?: string;
    sourceDir?: string;
}): Promise<PremiereDiagnosis>;
export interface OpenResult {
    project: PremiereProjectRef;
    /** CatCut started Premiere in this call */
    launched: boolean;
    /** CatCut opened the project (Premiere was running with another one, or started without it) */
    openedProject: boolean;
    pid?: number;
}
/**
 * Make `project` the active project in a connected Premiere: start Premiere with it when closed,
 * open it through the bridge when Premiere runs another one. Never closes or saves anything.
 */
export declare function openPremiere(client: PremiereClient, host: PremiereHost, opts: {
    premiereExe?: string;
    project: string;
    waitMs?: number;
    pollMs?: number;
    sourceDir?: string;
    activateAfterMs?: number;
}): Promise<OpenResult>;
export declare function bridgeSourceDir(): string;
export interface InstallResult {
    installedTo: string;
    debugModeKeys: string[];
    /** the previous bridge folder, copied before it was replaced (may hold per-job edits) */
    backup?: string;
    /** host.user.jsx carried over into the new install */
    keptUserActions: boolean;
}
/** Where replaced bridges are kept (outside the CEP folder: Premiere must not load them). */
export declare function bridgeBackupRoot(): string;
/**
 * Copies the extension into the user's CEP folder (replacing an older CatCut bridge only) and sets
 * PlayerDebugMode=1 for the CEP runtimes, which lets Premiere load an unsigned extension.
 * A running Premiere picks up host.jsx changes by itself; bridge-core/index changes need one restart.
 */
export declare function installBridge(opts?: {
    spawn?: SpawnFn;
    source?: string;
    extensionsDir?: string;
    backupRoot?: string;
    platform?: NodeJS.Platform;
}): Promise<InstallResult>;
/** Removes the extension folder (PlayerDebugMode stays: other unsigned extensions may need it). */
export declare function uninstallBridge(opts?: {
    extensionsDir?: string;
}): Promise<string>;
